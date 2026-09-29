import { PhaseEngine } from "./PhaseEngine.js";
import { EventBuilder } from "./EventBuilder.js";
import { ROLES, TEAMS, PHASES, teamOf } from "./constants.js";
import { generatePlayerId, secureShuffle } from "../security/random.js";

export const DEFAULT_SETTINGS = Object.freeze({
    nightSeconds: 60,
    morningSeconds: 10,
    discussionSeconds: 180,
    voteSeconds: 60,
    revealRoleOnDeath: true,
    testMode: false,
    mafiaCount: null, // null = automatic (about 1 per 3.5 players)
    includeDoctor: true,
    includeDetective: true,
});

export const MIN_PLAYERS = 5;
export const MIN_PLAYERS_TEST_MODE = 4;
export const DEFAULT_MAX_PLAYERS = 16;

/**
 * Pure game state + rules. No sockets, no timers: PhaseEngine drives phase
 * transitions and GameSession (server/game/GameSession.js) talks to players.
 */
export class Game {
    constructor(id, { maxPlayers = DEFAULT_MAX_PLAYERS, settings = {}, chatHistoryLimit = 200 } = {}) {
        this.id = id;
        this.maxPlayers = maxPlayers;
        this.settings = { ...DEFAULT_SETTINGS, ...settings };
        this.players = [];
        this.hostId = null;
        this.phase = PHASES.LOBBY;
        this.phaseEndsAt = null;
        this.round = 0;
        this.winner = null;
        this.events = [];
        this.eventSeq = 0;
        this.eventBuilder = new EventBuilder();
        this.phaseRunner = new PhaseEngine();
        this.resetRoundState();
        this.lastProtectedId = null;
        this.roleCounts = null;
        this.chatHistoryLimit = chatHistoryLimit;
        this.clearChat();
    }

    // -------------------------------------------------------------------------
    // Players
    // -------------------------------------------------------------------------

    addPlayer({ name, isBot = false }) {
        const player = {
            id: generatePlayerId(),
            name,
            role: null,
            alive: true,
            isBot,
            kicked: false,
            revealed: false,
            investigations: [],
            joinedAt: Date.now(),
        };
        this.players.push(player);
        if (!this.hostId && !isBot) this.hostId = player.id;
        return player;
    }

    removePlayer(id) {
        this.players = this.players.filter((p) => p.id !== id);
    }

    getPlayer(id) {
        return this.players.find((p) => p.id === id);
    }

    findPlayerByName(name) {
        const key = normalizeNameKey(name);
        return this.players.find((p) => normalizeNameKey(p.name) === key);
    }

    activePlayers() {
        return this.players.filter((p) => p.alive);
    }

    livingMafia() {
        return this.activePlayers().filter((p) => p.role === ROLES.MAFIA);
    }

    /** Legal Mafia victims: alive players who are not Mafia. */
    mafiaTargets() {
        return this.activePlayers().filter((p) => p.role !== ROLES.MAFIA);
    }

    livingWithRole(role) {
        return this.activePlayers().filter((p) => p.role === role);
    }

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    minPlayers() {
        return this.settings.testMode ? MIN_PLAYERS_TEST_MODE : MIN_PLAYERS;
    }

    /** Returns an error string if the game can't start, else null. */
    validateStart() {
        const n = this.players.length;
        if (n < this.minPlayers()) return `At least ${this.minPlayers()} players are needed`;
        if (n > this.maxPlayers) return "Too many players";
        const pool = Game.buildRolePool(n, this.settings);
        if (typeof pool === "string") return pool;
        return null;
    }

    assignRoles() {
        const pool = Game.buildRolePool(this.players.length, this.settings);
        if (typeof pool === "string") throw new Error(pool);
        secureShuffle(pool);
        this.players.forEach((player, index) => {
            player.role = pool[index];
        });
        this.roleCounts = countRoles(pool);
    }

    static autoMafiaCount(playerCount) {
        return Math.max(1, Math.floor(playerCount / 3.5));
    }

    /**
     * Returns an array of roles, or an error string when the requested setup
     * breaks the safety limits (Mafia < half, at least one plain Villager).
     */
    static buildRolePool(playerCount, settings = DEFAULT_SETTINGS) {
        const mafia = settings.mafiaCount ?? Game.autoMafiaCount(playerCount);
        const doctor = settings.includeDoctor ? 1 : 0;
        const detective = settings.includeDetective ? 1 : 0;
        const villagers = playerCount - mafia - doctor - detective;

        if (mafia < 1) return "There must be at least 1 Mafia";
        if (mafia * 2 >= playerCount) return "Mafia must be fewer than half the players";
        if (villagers < 1) return "There must be at least 1 Villager";

        return [
            ...Array(mafia).fill(ROLES.MAFIA),
            ...Array(detective).fill(ROLES.DETECTIVE),
            ...Array(doctor).fill(ROLES.DOCTOR),
            ...Array(villagers).fill(ROLES.VILLAGER),
        ];
    }

    // -------------------------------------------------------------------------
    // Round state
    // -------------------------------------------------------------------------

    resetRoundState() {
        this.night = { mafiaVotes: new Map(), doctorTarget: null, detectiveTarget: null };
        this.votes = new Map(); // voterId -> targetId | null (skip)
    }

    killPlayer(id, cause) {
        const player = this.getPlayer(id);
        if (!player || !player.alive) return null;
        player.alive = false;
        player.revealed = this.settings.revealRoleOnDeath;
        player.deathCause = cause;
        player.diedRound = this.round;
        // A dead player's pending choices no longer count.
        this.night.mafiaVotes.delete(id);
        this.votes.delete(id);
        for (const [voter, target] of this.votes) if (target === id) this.votes.delete(voter);
        for (const [voter, target] of this.night.mafiaVotes) if (target === id) this.night.mafiaVotes.delete(voter);
        return player;
    }

    setPhase(phase, endsAt = null) {
        this.phase = phase;
        this.phaseEndsAt = endsAt;
        this.addEvent("phase_changed", { phase, round: this.round });
    }

    nextRound() {
        this.round++;
        this.addEvent("round_started", { round: this.round });
    }

    /**
     * Checks both win conditions and records the winner. Returns the winner
     * object or null while the game goes on.
     */
    checkWinCondition() {
        if (this.winner) return this.winner;
        const alive = this.activePlayers();
        const mafiaAlive = alive.filter((p) => p.role === ROLES.MAFIA).length;
        const townAlive = alive.length - mafiaAlive;

        if (mafiaAlive === 0) {
            this.winner = { team: TEAMS.TOWN, reason: "All Mafia have been eliminated" };
        } else if (mafiaAlive >= townAlive) {
            this.winner = { team: TEAMS.MAFIA, reason: "The Mafia equal or outnumber the town" };
        }
        return this.winner;
    }

    // -------------------------------------------------------------------------
    // Chat
    // -------------------------------------------------------------------------

    clearChat() {
        this.chat = { general: [], mafia: [], dead: [], system: [] };
        this.chatSeq = 0;
    }

    /** Stores a message. `from` is a player, or null for the server. Permission checks happen in GameSession. */
    addChat(channel, from, text) {
        const message = {
            id: ++this.chatSeq,
            channel,
            ts: Date.now(),
            from: from ? { id: from.id, name: from.name } : null,
            text,
        };
        const log = this.chat[channel];
        log.push(message);
        if (log.length > this.chatHistoryLimit) log.splice(0, log.length - this.chatHistoryLimit);
        return message;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * Every event is a structured object. `visibility` decides who may see it
     * (see server/game/view.js canSeeEvent):
     *   { public: true } | { mafia: true, dead: true, players: [ids] }
     */
    addEvent(type, data = {}, visibility = { public: true }) {
        const event = this.eventBuilder.build(this, type, data, visibility);
        this.events.push(event);
        if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
        return event;
    }
}

export function countRoles(pool) {
    const counts = {};
    for (const role of pool) counts[role] = (counts[role] || 0) + 1;
    return counts;
}

/** Case-insensitive, whitespace-insensitive key for name uniqueness and bans. */
export function normalizeNameKey(name) {
    return String(name).toLowerCase().replace(/[\s_-]+/g, "");
}

export { ROLES, TEAMS, PHASES, teamOf };
