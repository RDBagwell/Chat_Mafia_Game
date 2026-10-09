import { Game, normalizeNameKey } from "./Game.js";
import { PHASES, ROLES, TEAMS } from "./constants.js";
import { CHANNELS, canRead, canWrite, readableChannels, roomName } from "./channels.js";
import { getViewFor, availableAction } from "./view.js";
import { GAME_COMMANDS, sanitizeChat, sanitizeName, validateEvent } from "../security/validation.js";
import { KeyedRateLimiter } from "../security/rateLimit.js";
import { generateToken, hashToken } from "../security/random.js";

/**
 * Every message a client can see on failure. Kept deliberately small and
 * generic so errors never reveal hidden state or internals.
 */
export const ERRORS = Object.freeze({
    invalid: "Invalid request.",
    rateLimited: "You're doing that too fast. Slow down.",
    notAllowed: "You can't do that right now.",
    notHost: "Only the host can do that.",
    badTarget: "That's not a valid target.",
    joinFailed: "Game not found, full, or already started.",
    nameTaken: "That name is already taken in this game.",
    full: "This game is full.",
    botsDisabled: "Bots are not available.",
    aiDisabled: "AI players are not enabled on this server.",
});

export const realScheduler = Object.freeze({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    now: () => Date.now(),
});

const BOT_NAMES = [
    "Ada", "Babbage", "Curie", "Darwin", "Euler", "Fermi", "Gauss", "Hopper",
    "Info", "Joule", "Kepler", "Lovelace", "Mendel", "Newton", "Ohm", "Planck",
];

const fail = (error) => ({ ok: false, error });
const OK = Object.freeze({ ok: true });

/**
 * One running game: the Game state, its timers, and the controllers (human
 * sockets or bots) sitting in each seat. Humans and bots go through exactly the
 * same entry point, handleCommand(), so every rule and validation applies to
 * both.
 *
 * Controller interface (see server/players/PlayerController.js):
 *   onState(view)   — full getViewFor() snapshot for that seat
 *   onChat(message) — a message the seat may read (skipped if usesRooms)
 *   onKicked()      — the seat was kicked
 *   detach(reason)  — the controller is no longer attached to this seat
 *   syncRooms(list) — optional: [[room, member]] for Socket.io room membership
 *   usesRooms       — true if chat reaches it via transport rooms
 */
export class GameSession {
    constructor(id, { config, scheduler = realScheduler, transport = null, botFactory = null, log = () => {} }) {
        this.id = id;
        this.config = config;
        this.scheduler = scheduler;
        this.transport = transport;
        this.botFactory = botFactory;
        this.log = log;

        this.game = new Game(id, {
            maxPlayers: config.maxPlayersPerGame,
            chatHistoryLimit: config.chatHistoryLimit,
        });
        this.engine = this.game.phaseRunner;
        this.game.features = { aiPlayers: Boolean(botFactory?.features?.aiPlayers) };

        this.controllers = new Map(); // playerId -> controller
        this.tokens = new Map(); // sha256(token) -> playerId
        this.bannedTokens = new Set();
        this.bannedNames = new Set();
        this.chatLimiter = new KeyedRateLimiter(config.limits.chat, scheduler.now);
        this.actionLimiter = new KeyedRateLimiter(config.limits.action, scheduler.now);

        this.phaseTimer = null;
        this.phaseSeq = 0;
        this.hostTimer = null;
        this.hostTransferPending = false;
        this.removalTimers = new Map();
        this.readableSignature = new Map();
        this.createdAt = scheduler.now();
        this.lastActivityAt = this.createdAt;
        this.destroyed = false;
    }

    now() {
        return this.scheduler.now();
    }

    touch() {
        this.lastActivityAt = this.now();
    }

    // =========================================================================
    // Seats: join, resume, disconnect, leave
    // =========================================================================

    /** Seats a new player (lobby only). Returns { ok, player, token } — token only for humans. */
    join({ name, controller, isBot = false, botKind = null }) {
        const game = this.game;
        if (this.destroyed || game.phase !== PHASES.LOBBY) return fail(ERRORS.joinFailed);
        if (game.players.length >= game.maxPlayers) return fail(ERRORS.full);

        const clean = sanitizeName(name);
        if (!clean.ok) return fail(clean.error);
        if (this.bannedNames.has(normalizeNameKey(clean.value))) return fail(ERRORS.joinFailed);
        if (game.findPlayerByName(clean.value)) return fail(ERRORS.nameTaken);

        const player = game.addPlayer({ name: clean.value, isBot });
        player.botKind = isBot ? botKind ?? "random" : null;
        player.connected = true;
        player.connectedSince = this.now();

        let token = null;
        if (!isBot) {
            token = generateToken();
            player.tokenHash = hashToken(token);
            this.tokens.set(player.tokenHash, player.id);
        }
        this.controllers.set(player.id, controller);
        controller.attach?.(this, player.id);

        game.addEvent("player_joined", { playerId: player.id, name: player.name, isBot });
        this.system(`${player.name} joined the game.`);
        this.touch();
        this.broadcastState({ forceChatFor: player.id });
        return { ok: true, player, token };
    }

    /** Looks up a seat by session token. Returns the player id or null. */
    playerIdForToken(token) {
        const hash = hashToken(token);
        if (this.bannedTokens.has(hash)) return null;
        const playerId = this.tokens.get(hash);
        const player = playerId && this.game.getPlayer(playerId);
        return player && !player.kicked ? player.id : null;
    }

    /** Puts a (new) controller in an existing seat, e.g. a reconnecting socket. */
    reattach(playerId, controller) {
        const player = this.game.getPlayer(playerId);
        if (!player || player.kicked || this.destroyed) return false;

        const previous = this.controllers.get(playerId);
        if (previous && previous !== controller) previous.detach?.("replaced");
        this.controllers.set(playerId, controller);
        controller.attach?.(this, playerId);

        const wasDisconnected = !player.connected;
        player.connected = true;
        if (wasDisconnected) player.connectedSince = this.now();
        this.scheduler.clearTimeout(this.removalTimers.get(playerId));
        this.removalTimers.delete(playerId);

        if (player.id === this.game.hostId) {
            this.scheduler.clearTimeout(this.hostTimer);
            this.hostTimer = null;
            this.hostTransferPending = false;
        } else if (this.hostTransferPending) {
            this.transferHost();
        }
        if (wasDisconnected) this.system(`${player.name} reconnected.`);
        this.touch();
        this.broadcastState({ forceChatFor: playerId });
        return true;
    }

    /** A controller lost its connection. Ignored if that controller was already replaced. */
    disconnected(playerId, controller) {
        const player = this.game.getPlayer(playerId);
        if (!player || this.controllers.get(playerId) !== controller) return;
        player.connected = false;
        player.disconnectedAt = this.now();

        if (this.game.phase === PHASES.LOBBY) {
            // Lobby seats are released after the grace period.
            const timer = this.scheduler.setTimeout(
                () => this.safe(() => {
                    const p = this.game.getPlayer(playerId);
                    if (p && !p.connected && this.game.phase === PHASES.LOBBY) this.removeSeat(playerId, "left");
                }),
                this.config.reconnectGraceMs
            );
            this.removalTimers.set(playerId, timer);
        }
        // Mid-game seats are kept for the rest of the game, so role counts and
        // win checks stay correct; the player can reconnect with their token.

        if (playerId === this.game.hostId) {
            this.scheduler.clearTimeout(this.hostTimer);
            this.hostTimer = this.scheduler.setTimeout(
                () => this.safe(() => {
                    const host = this.game.getPlayer(this.game.hostId);
                    if (!host || !host.connected) {
                        this.transferHost();
                        this.broadcastState();
                    }
                }),
                this.config.hostTransferMs
            );
        }

        this.system(`${player.name} disconnected.`);
        this.broadcastState();
    }

    /** Removes a seat entirely (lobby, or a new game reset). */
    removeSeat(playerId, reason) {
        const player = this.game.getPlayer(playerId);
        if (!player) return;
        this.game.removePlayer(playerId);
        if (player.tokenHash) this.tokens.delete(player.tokenHash);
        const controller = this.controllers.get(playerId);
        this.controllers.delete(playerId);
        this.readableSignature.delete(playerId);
        if (reason !== "kicked") controller?.detach?.(reason);
        this.scheduler.clearTimeout(this.removalTimers.get(playerId));
        this.removalTimers.delete(playerId);

        if (reason === "left") {
            this.game.addEvent("player_left", { playerId, name: player.name });
            this.system(`${player.name} left the game.`);
        }
        if (playerId === this.game.hostId) {
            this.game.hostId = null;
            this.transferHost();
        }
        this.broadcastState();
    }

    /** Gives host to the longest-connected human. */
    transferHost() {
        const game = this.game;
        const candidates = game.players
            .filter((p) => !p.isBot && !p.kicked && p.connected && p.id !== game.hostId)
            .sort((a, b) => a.connectedSince - b.connectedSince);
        const next = candidates[0];
        if (!next) {
            this.hostTransferPending = true;
            return false;
        }
        this.hostTransferPending = false;
        this.scheduler.clearTimeout(this.hostTimer);
        this.hostTimer = null;
        game.hostId = next.id;
        game.addEvent("host_changed", { playerId: next.id, name: next.name });
        this.system(`${next.name} is now the host.`);
        return true;
    }

    hasConnectedHumans() {
        return this.game.players.some((p) => !p.isBot && !p.kicked && p.connected);
    }

    // =========================================================================
    // Commands (humans and bots)
    // =========================================================================

    /**
     * The single entry point for every in-game action. `payload` is untrusted:
     * it is validated here even if the caller already validated it.
     */
    handleCommand(playerId, type, payload) {
        if (this.destroyed || !GAME_COMMANDS.has(type)) return fail(ERRORS.invalid);
        const valid = validateEvent(type, payload);
        if (!valid.ok) return fail(ERRORS.invalid);

        const player = this.game.getPlayer(playerId);
        if (!player || player.kicked) return fail(ERRORS.notAllowed);

        const limiter = type === "chat" ? this.chatLimiter : this.actionLimiter;
        if (!limiter.take(playerId)) return fail(ERRORS.rateLimited);

        if (!player.isBot) this.touch(); // bots alone don't keep a game alive
        switch (type) {
            case "chat": return this.chat(player, valid.data);
            case "nightAction": return this.nightAction(player, valid.data);
            case "vote": return this.vote(player, valid.data);
            case "updateSettings": return this.updateSettings(player, valid.data);
            case "startGame": return this.startGame(player);
            case "advancePhase": return this.advancePhase(player);
            case "kick": return this.kick(player, valid.data);
            case "addBot": return this.addBot(player, valid.data);
            case "newGame": return this.newGame(player);
            case "leaveGame": return this.leave(player);
            default: return fail(ERRORS.invalid);
        }
    }

    isHost(player) {
        return player.id === this.game.hostId;
    }

    chat(player, { channel, text }) {
        // Permission is re-checked on every message, whatever room the socket is in.
        if (!canWrite(this.game, player, channel)) return fail(ERRORS.notAllowed);
        const clean = sanitizeChat(text);
        if (!clean.ok) return fail(ERRORS.invalid);
        const message = this.game.addChat(channel, player, clean.value);
        this.deliverChat(message);
        return OK;
    }

    nightAction(player, { targetId }) {
        const game = this.game;
        const action = availableAction(game, player);
        if (game.phase !== PHASES.NIGHT || !action) return fail(ERRORS.notAllowed);
        if (!action.targets.includes(targetId)) return fail(ERRORS.badTarget);
        const target = game.getPlayer(targetId);

        switch (action.type) {
            case "kill":
                game.night.mafiaVotes.set(player.id, targetId);
                this.system(`${player.name} votes to kill ${target.name}.`, "mafia");
                break;
            case "protect":
                game.night.doctorTarget = { actorId: player.id, targetId };
                this.system(`Doctor ${player.name} protects ${target.name}.`, "dead");
                break;
            case "investigate":
                game.night.detectiveTarget = { actorId: player.id, targetId };
                this.system(`Detective ${player.name} investigates ${target.name}.`, "dead");
                break;
            default:
                return fail(ERRORS.notAllowed);
        }
        this.broadcastState();
        if (this.nightComplete()) this.advance();
        return OK;
    }

    /** True when every living night role has acted. */
    nightComplete() {
        const game = this.game;
        for (const p of game.activePlayers()) {
            if (p.role === ROLES.MAFIA && !game.night.mafiaVotes.has(p.id)) return false;
            if (p.role === ROLES.DOCTOR && game.night.doctorTarget?.actorId !== p.id) return false;
            if (p.role === ROLES.DETECTIVE && game.night.detectiveTarget?.actorId !== p.id) return false;
        }
        return true;
    }

    vote(player, { targetId }) {
        const game = this.game;
        const action = availableAction(game, player);
        if (game.phase !== PHASES.VOTE || action?.type !== "vote") return fail(ERRORS.notAllowed);
        if (targetId !== null && !action.targets.includes(targetId)) return fail(ERRORS.badTarget);

        const changed = game.votes.has(player.id);
        game.votes.set(player.id, targetId);
        const target = targetId ? game.getPlayer(targetId) : null;
        const verb = changed ? "changes their vote to" : "votes for";
        this.system(target ? `${player.name} ${verb} ${target.name}.` : `${player.name} ${changed ? "changes their vote to skip" : "votes to skip"}.`);
        game.addEvent("vote_cast", { voterId: player.id, targetId });

        this.broadcastState();
        if (this.allVoted()) this.advance();
        return OK;
    }

    allVoted() {
        return this.game.activePlayers().every((p) => this.game.votes.has(p.id));
    }

    updateSettings(player, { settings }) {
        if (!this.isHost(player)) return fail(ERRORS.notHost);
        if (this.game.phase !== PHASES.LOBBY) return fail(ERRORS.notAllowed);
        Object.assign(this.game.settings, settings);
        this.broadcastState();
        return OK;
    }

    startGame(player) {
        const game = this.game;
        if (!this.isHost(player)) return fail(ERRORS.notHost);
        if (game.phase !== PHASES.LOBBY) return fail(ERRORS.notAllowed);
        const problem = game.validateStart();
        if (problem) return fail(problem);

        for (const timer of this.removalTimers.values()) this.scheduler.clearTimeout(timer);
        this.removalTimers.clear();

        this.engine.startGame(game, this.now());
        const counts = Object.entries(game.roleCounts).map(([role, n]) => `${n} ${role}`).join(", ");
        this.system(`The game has started. Roles in play: ${counts}.`);
        const mafia = game.players.filter((p) => p.role === ROLES.MAFIA).map((p) => p.name);
        this.system(`The Mafia are: ${mafia.join(", ")}. Choose a victim each night.`, "mafia");
        this.afterTransition();
        return OK;
    }

    advancePhase(player) {
        if (!this.isHost(player)) return fail(ERRORS.notHost);
        const phase = this.game.phase;
        if (phase === PHASES.LOBBY || phase === PHASES.ENDED) return fail(ERRORS.notAllowed);
        this.advance();
        return OK;
    }

    kick(host, { playerId }) {
        const game = this.game;
        if (!this.isHost(host)) return fail(ERRORS.notHost);
        const target = game.getPlayer(playerId);
        if (!target || target.kicked || target.id === host.id) return fail(ERRORS.badTarget);

        // Ban both the session token and the (normalized) name for this game.
        if (target.tokenHash) {
            this.bannedTokens.add(target.tokenHash);
            this.tokens.delete(target.tokenHash);
        }
        this.bannedNames.add(normalizeNameKey(target.name));

        const controller = this.controllers.get(target.id);
        controller?.onKicked?.();
        controller?.detach?.("kicked");

        if (game.phase === PHASES.LOBBY) {
            this.system(`${target.name} was kicked by the host.`);
            this.removeSeat(target.id, "kicked");
            return OK;
        }

        this.controllers.delete(target.id);
        this.readableSignature.delete(target.id);
        const wasAlive = target.alive;
        game.killPlayer(target.id, "kicked");
        target.kicked = true;
        target.connected = false;
        const reveal = target.revealed && game.phase !== PHASES.ENDED ? ` They were ${article(target.role)}.` : "";
        game.addEvent("player_kicked", { playerId: target.id, name: target.name, role: target.revealed ? target.role : null });
        this.system(`${target.name} was kicked by the host.${reveal}`);

        if (wasAlive && this.engine.checkForWin(game)) {
            this.announcePhase();
            this.afterTransition({ announce: false });
            return OK;
        }
        this.broadcastState();
        if (game.phase === PHASES.NIGHT && this.nightComplete()) this.advance();
        else if (game.phase === PHASES.VOTE && this.allVoted()) this.advance();
        return OK;
    }

    addBot(player, { kind = "random" } = {}) {
        const game = this.game;
        if (!this.isHost(player)) return fail(ERRORS.notHost);
        if (game.phase !== PHASES.LOBBY) return fail(ERRORS.notAllowed);
        if (!this.botFactory) return fail(ERRORS.botsDisabled);
        if (game.players.length >= game.maxPlayers) return fail(ERRORS.full);
        const prefix = kind === "llm" ? "AI" : "Bot";
        const name = BOT_NAMES.map((n) => `${prefix} ${n}`).find((n) => !game.findPlayerByName(n) && !this.bannedNames.has(normalizeNameKey(n)));
        if (!name) return fail(ERRORS.full);
        const controller = this.botFactory(this, kind);
        if (!controller) return fail(kind === "llm" ? ERRORS.aiDisabled : ERRORS.botsDisabled);
        const result = this.join({ name, controller, isBot: true, botKind: kind });
        return result.ok ? OK : result;
    }

    /** After game over, the host resets to a fresh lobby with the same seats. */
    newGame(player) {
        const game = this.game;
        if (!this.isHost(player)) return fail(ERRORS.notHost);
        if (game.phase !== PHASES.ENDED) return fail(ERRORS.notAllowed);

        for (const p of [...game.players]) {
            if (p.kicked || (!p.isBot && !p.connected)) this.removeSeat(p.id, "reset");
        }
        for (const p of game.players) {
            Object.assign(p, { role: null, alive: true, revealed: false, investigations: [], deathCause: null, diedRound: null });
        }
        Object.assign(game, { phase: PHASES.LOBBY, phaseEndsAt: null, round: 0, winner: null, events: [], roleCounts: null, lastProtectedId: null });
        game.resetRoundState();
        game.clearChat();
        this.llmBudget?.reset();
        this.readableSignature.clear();
        if (!game.getPlayer(game.hostId)) this.transferHost();
        this.system("The host started a new game. Waiting in the lobby.");
        this.broadcastState({ forceChatForAll: true });
        return OK;
    }

    leave(player) {
        if (this.game.phase === PHASES.LOBBY) {
            this.removeSeat(player.id, "left");
        } else {
            const controller = this.controllers.get(player.id);
            this.disconnected(player.id, controller);
            controller?.detach?.("left");
        }
        return OK;
    }

    // =========================================================================
    // Phase flow
    // =========================================================================

    advance() {
        if (this.destroyed) return;
        const transition = this.engine.advance(this.game, this.now());
        if (!transition) return;
        if (transition.from === PHASES.NIGHT) this.reportNight(transition.result);
        if (transition.from === PHASES.VOTE) this.reportVote(transition.result);
        this.afterTransition();
    }

    afterTransition({ announce = true } = {}) {
        if (announce) this.announcePhase();
        this.schedulePhaseTimer();
        this.broadcastState();
    }

    schedulePhaseTimer() {
        this.scheduler.clearTimeout(this.phaseTimer);
        this.phaseTimer = null;
        const seq = ++this.phaseSeq;
        const endsAt = this.game.phaseEndsAt;
        if (!endsAt) return;
        this.phaseTimer = this.scheduler.setTimeout(
            () => this.safe(() => {
                if (seq === this.phaseSeq) this.advance();
            }),
            Math.max(0, endsAt - this.now())
        );
    }

    announcePhase() {
        const game = this.game;
        switch (game.phase) {
            case PHASES.NIGHT:
                this.system(`Night ${game.round} falls. Mafia, Doctor and Detective: make your choices.`);
                break;
            case PHASES.DISCUSSION:
                this.system(`Day ${game.round}: discussion is open.`);
                break;
            case PHASES.VOTE:
                this.system("Voting is open. Vote for a player, or skip.");
                break;
            case PHASES.ENDED: {
                const team = game.winner?.team === TEAMS.MAFIA ? "The Mafia win" : "The town wins";
                this.system(`Game over: ${team}! ${game.winner?.reason ?? ""}.`);
                const roles = game.players.map((p) => `${p.name}: ${p.role}`).join(", ");
                this.system(`Roles: ${roles}.`);
                break;
            }
            default:
                break;
        }
    }

    reportNight(result) {
        const game = this.game;
        const name = (id) => game.getPlayer(id)?.name ?? "nobody";
        // Observers (dead) get the full picture; the living only learn who died.
        const parts = [`Night ${game.round}: the Mafia targeted ${name(result.targetedId)}`];
        parts.push(`the Doctor protected ${name(result.protectedId)}${result.saved ? " (saved!)" : ""}`);
        if (result.investigation) parts.push(`the Detective investigated ${name(result.investigation.targetId)}: ${result.investigation.result}`);
        else parts.push("the Detective investigated nobody");
        this.system(parts.join("; ") + ".", "dead");

        if (result.killedId) {
            const victim = game.getPlayer(result.killedId);
            const reveal = victim.revealed ? ` They were ${article(victim.role)}.` : "";
            this.system(`Morning: ${victim.name} was killed in the night.${reveal}`);
        } else {
            this.system("Morning: nobody died last night.");
        }
    }

    reportVote(result) {
        const game = this.game;
        if (result.executedId) {
            const p = game.getPlayer(result.executedId);
            const reveal = p.revealed ? ` They were ${article(p.role)}.` : "";
            this.system(`${p.name} was executed by the town.${reveal}`);
        } else if (result.tie) {
            this.system("The vote was tied. Nobody is executed.");
        } else if (result.skipped) {
            this.system("The town voted to skip. Nobody is executed.");
        } else {
            this.system("Nobody voted. Nobody is executed.");
        }
    }

    // =========================================================================
    // Output
    // =========================================================================

    system(text, channel = "system") {
        this.deliverChat(this.game.addChat(channel, null, text));
    }

    /** Keeps each human socket's channel rooms equal to what canRead allows right now. */
    syncRooms() {
        for (const [playerId, controller] of this.controllers) {
            if (!controller.syncRooms) continue;
            const player = this.game.getPlayer(playerId);
            controller.syncRooms(CHANNELS.map((c) => [roomName(this.id, c), canRead(this.game, player, c)]));
        }
    }

    deliverChat(message) {
        this.syncRooms();
        if (this.transport) this.transport.toRoom(roomName(this.id, message.channel), "chat", message);
        for (const [playerId, controller] of this.controllers) {
            if (controller.usesRooms && this.transport) continue;
            if (canRead(this.game, this.game.getPlayer(playerId), message.channel)) {
                this.safe(() => controller.onChat?.({ ...message }));
            }
        }
    }

    broadcastState({ forceChatFor = null, forceChatForAll = false } = {}) {
        if (this.destroyed) return;
        this.syncRooms();
        const now = this.now();
        for (const [playerId, controller] of this.controllers) {
            const player = this.game.getPlayer(playerId);
            if (!player) continue;
            const signature = readableChannels(this.game, player).join(",");
            const includeChat =
                forceChatForAll || forceChatFor === playerId || signature !== this.readableSignature.get(playerId);
            this.readableSignature.set(playerId, signature);
            const view = getViewFor(this.game, playerId, { now, includeChat });
            if (view) this.safe(() => controller.onState?.(view));
        }
    }

    safe(fn) {
        try {
            return fn();
        } catch (err) {
            this.log("error", `game ${this.id}: ${err?.stack || err}`);
            return undefined;
        }
    }

    destroy(reason = "closed") {
        if (this.destroyed) return;
        this.destroyed = true;
        this.scheduler.clearTimeout(this.phaseTimer);
        this.scheduler.clearTimeout(this.hostTimer);
        for (const timer of this.removalTimers.values()) this.scheduler.clearTimeout(timer);
        for (const controller of this.controllers.values()) this.safe(() => controller.detach?.(reason));
        this.controllers.clear();
    }
}

function article(role) {
    return /^[AEIOU]/.test(role) ? `an ${role}` : `a ${role}`;
}
