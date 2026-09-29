import { HumanController } from "../players/HumanController.js";
import { ERRORS } from "../game/GameSession.js";
import { GAME_COMMANDS, eventSchemas, normalizeGameCode, sanitizeName, validateEvent } from "../security/validation.js";
import { KeyedRateLimiter, TokenBucket } from "../security/rateLimit.js";

const SESSION_EVENTS = new Set(["createGame", "joinGame", "resume"]);
const KNOWN_EVENTS = new Set(Object.keys(eventSchemas));
const MAX_VIOLATIONS = 20;

/**
 * Socket.io boundary. Everything that arrives here is hostile until proven
 * otherwise: every event must be known, its payload must pass its zod schema,
 * and identity comes only from socket.data.seat, which only the server sets.
 */
export class SocketController {
    constructor(io, manager, config, log = () => {}) {
        this.io = io;
        this.manager = manager;
        this.config = config;
        this.log = log;
        this.joinLimiter = new KeyedRateLimiter(config.limits.joinPerIp);
        this.createLimiter = new KeyedRateLimiter(config.limits.createPerIp);
        this.connectLimiter = new KeyedRateLimiter(config.limits.connectPerIp);
        this.connectionsPerIp = new Map();

        this.pruner = setInterval(() => {
            for (const limiter of [this.joinLimiter, this.createLimiter, this.connectLimiter]) limiter.prune();
        }, 60_000);
        this.pruner.unref?.();

        io.use((socket, next) => this.admit(socket, next));
        io.on("connection", (socket) => this.register(socket));
    }

    stop() {
        clearInterval(this.pruner);
    }

    // -------------------------------------------------------------------------
    // Connection admission
    // -------------------------------------------------------------------------

    clientIp(socket) {
        const hops = this.config.trustProxyHops;
        const direct = socket.handshake.address;
        const header = this.config.clientIpHeader;
        if (header) {
            const value = String(socket.handshake.headers[header] || "").trim();
            if (/^[0-9a-fA-F:.]{2,45}$/.test(value)) return value;
        }
        if (!hops) return direct;
        const forwarded = String(socket.handshake.headers["x-forwarded-for"] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        // Each trusted proxy appends the address it saw; entries before those
        // are client-controlled and ignored.
        return forwarded[Math.max(0, forwarded.length - hops)] || direct;
    }

    admit(socket, next) {
        const ip = this.clientIp(socket);
        socket.data.ip = ip;
        const open = this.connectionsPerIp.get(ip) || 0;
        if (open >= this.config.limits.maxConcurrentPerIp || !this.connectLimiter.take(ip)) {
            return next(new Error("Too many connections"));
        }
        this.connectionsPerIp.set(ip, open + 1);
        socket.data.counted = true;
        next();
    }

    register(socket) {
        socket.data.seat = null;
        socket.data.violations = 0;
        socket.data.bucket = new TokenBucket(this.config.limits.socketEvents);

        socket.onAny((event) => {
            if (!KNOWN_EVENTS.has(event)) this.violation(socket, ERRORS.invalid);
        });

        for (const event of KNOWN_EVENTS) {
            socket.on(event, (payload, ack) => this.dispatch(socket, event, payload, ack));
        }

        socket.on("disconnect", () =>
            this.safe(socket, "disconnect", () => {
                if (socket.data.counted) {
                    const ip = socket.data.ip;
                    const left = (this.connectionsPerIp.get(ip) || 1) - 1;
                    if (left > 0) this.connectionsPerIp.set(ip, left);
                    else this.connectionsPerIp.delete(ip);
                }
                const { seat, controller } = socket.data;
                if (seat) this.manager.get(seat.gameId)?.disconnected(seat.playerId, controller);
            })
        );
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    dispatch(socket, event, payload, ack) {
        // Allow emit(event, ack) with no payload.
        if (typeof payload === "function" && ack === undefined) {
            ack = payload;
            payload = undefined;
        }
        const reply = (result) => {
            if (typeof ack === "function") ack(result);
            else if (!result.ok) socket.emit("serverError", { message: result.error });
        };

        this.safe(socket, event, () => {
            if (!socket.data.bucket.take()) return reply(this.violation(socket, ERRORS.rateLimited, false));
            const valid = validateEvent(event, payload);
            if (!valid.ok) return reply(this.violation(socket, ERRORS.invalid, false));

            if (SESSION_EVENTS.has(event)) return reply(this[event](socket, valid.data));
            if (GAME_COMMANDS.has(event)) return reply(this.command(socket, event, valid.data));
            return reply({ ok: false, error: ERRORS.invalid });
        }, reply);
    }

    /** Counts abuse; persistent offenders are disconnected. */
    violation(socket, error, emit = true) {
        socket.data.violations++;
        if (socket.data.violations > MAX_VIOLATIONS) {
            this.log("warn", "disconnecting socket after repeated invalid or excessive events");
            socket.disconnect(true);
        } else if (emit) {
            socket.emit("serverError", { message: error });
        }
        return { ok: false, error };
    }

    command(socket, event, data) {
        const seat = socket.data.seat;
        const session = seat && this.manager.get(seat.gameId);
        if (!session) return { ok: false, error: ERRORS.notAllowed };
        return session.handleCommand(seat.playerId, event, data);
    }

    /** A socket holds at most one seat; taking a new one releases the old. */
    releaseSeat(socket) {
        const { seat } = socket.data;
        if (!seat) return;
        const session = this.manager.get(seat.gameId);
        const player = session?.game.getPlayer(seat.playerId);
        // Direct call, not handleCommand: releasing a seat must not be rate limited.
        if (player) session.leave(player);
        socket.data.controller?.detach("left");
    }

    createGame(socket, { name }) {
        const ip = socket.data.ip;
        const clean = sanitizeName(name);
        if (!clean.ok) return { ok: false, error: clean.error };
        if (!this.createLimiter.take(ip)) return { ok: false, error: ERRORS.rateLimited };

        this.releaseSeat(socket);
        const session = this.manager.create();
        if (!session) return { ok: false, error: "The server is full right now. Try again later." };

        const result = session.join({ name: clean.value, controller: new HumanController(socket) });
        if (!result.ok) {
            this.manager.remove(session.id);
            return { ok: false, error: result.error };
        }
        this.log("info", "game created");
        return { ok: true, gameId: session.id, playerId: result.player.id, token: result.token };
    }

    joinGame(socket, { gameId, name }) {
        if (!this.joinLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        const code = normalizeGameCode(gameId);
        const session = code && this.manager.get(code);
        if (!session) return { ok: false, error: ERRORS.joinFailed };

        this.releaseSeat(socket);
        const result = session.join({ name, controller: new HumanController(socket) });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, gameId: session.id, playerId: result.player.id, token: result.token };
    }

    resume(socket, { gameId, token }) {
        if (!this.joinLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        const code = normalizeGameCode(gameId);
        const session = code && this.manager.get(code);
        const playerId = session?.playerIdForToken(token);
        if (!playerId) return { ok: false, error: "That session has expired. Join again with the game code." };

        if (socket.data.seat?.playerId !== playerId) this.releaseSeat(socket);
        session.reattach(playerId, new HumanController(socket));
        return { ok: true, gameId: session.id, playerId };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Errors never crash the process and never reach the client verbatim. */
    safe(socket, event, fn, reply) {
        try {
            fn();
        } catch (err) {
            this.log("error", `handler "${event}" failed: ${err?.stack || err}`);
            reply?.({ ok: false, error: "Something went wrong." });
        }
    }
}
