import { io as ioClient } from "socket.io-client";
import { createServer } from "../server/app.js";
import { loadConfig } from "../server/config.js";

export const ORIGIN = "http://localhost:3000";

export function testConfig(overrides = {}) {
    const base = loadConfig({});
    return {
        ...base,
        ...overrides,
        limits: {
            ...base.limits,
            // Generous by default so tests aren't throttled; limit tests override.
            joinPerIp: { capacity: 1000, windowMs: 1000 },
            createPerIp: { capacity: 1000, windowMs: 1000 },
            connectPerIp: { capacity: 1000, windowMs: 1000 },
            maxConcurrentPerIp: 1000,
            socketEvents: { capacity: 1000, windowMs: 1000 },
            action: { capacity: 1000, windowMs: 1000 },
            ...overrides.limits,
        },
        bots: { minDelayMs: 0, maxDelayMs: 5, chatChance: 0.3, ...overrides.bots },
    };
}

export async function startServer(options = {}) {
    const server = createServer({ log: () => {}, ...options, config: testConfig(options.config) });
    const port = await server.listen(0);
    const url = `http://127.0.0.1:${port}`;
    const clients = [];

    function connect({ origin = ORIGIN } = {}) {
        const socket = ioClient(url, {
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
            extraHeaders: origin ? { origin } : {},
        });
        const client = new TestClient(socket);
        clients.push(client);
        return client;
    }

    async function close() {
        for (const c of clients) c.socket.disconnect();
        await server.close();
    }

    return { server, url, connect, close };
}

/** Wraps a socket.io-client socket and records everything it receives. */
export class TestClient {
    constructor(socket) {
        this.socket = socket;
        this.states = [];
        this.chats = [];
        this.errors = [];
        this.ended = null;
        this.raw = []; // every payload received, for leak scanning
        socket.onAny((event, payload) => this.raw.push({ event, payload }));
        socket.on("state", (s) => this.states.push(s));
        socket.on("chat", (m) => this.chats.push(m));
        socket.on("serverError", (e) => this.errors.push(e));
        socket.on("sessionEnded", (e) => (this.ended = e));
        this.connected = new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("connect_error", reject);
        });
    }

    get state() {
        return this.states.at(-1);
    }

    get id() {
        return this.state?.you.id;
    }

    request(event, payload) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
            this.socket.emit(event, payload, (res) => {
                clearTimeout(timer);
                resolve(res);
            });
        });
    }

    /** Waits until the latest state matches `predicate`. */
    waitForState(predicate, timeout = 3000) {
        return waitFor(() => this.state && predicate(this.state), timeout, "state");
    }

    waitForChat(predicate, timeout = 3000) {
        return waitFor(() => this.chats.find(predicate), timeout, "chat");
    }

    chatText() {
        return this.chats.map((m) => m.text);
    }
}

export async function waitFor(fn, timeout = 3000, what = "condition") {
    const start = Date.now();
    for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates a game with `count` human players (the first is the host) and
 * optionally starts it. Returns { host, players, gameId }.
 */
export async function setupGame(env, count, { start = true, settings = {} } = {}) {
    const host = env.connect();
    await host.connected;
    const created = await host.request("createGame", { name: "Alice" });
    if (!created.ok) throw new Error(created.error);
    host.token = created.token;
    const players = [host];
    for (let i = 1; i < count; i++) {
        const c = env.connect();
        await c.connected;
        const res = await c.request("joinGame", { gameId: created.gameId, name: `Player${i}` });
        if (!res.ok) throw new Error(res.error);
        c.token = res.token;
        players.push(c);
    }
    await host.waitForState((s) => s.players.length === count);
    if (Object.keys(settings).length) await host.request("updateSettings", { settings });
    if (start) {
        const res = await host.request("startGame", {});
        if (!res.ok) throw new Error(res.error);
        await Promise.all(players.map((p) => p.waitForState((s) => s.phase === "night")));
    }
    return { host, players, gameId: created.gameId };
}

export function byRole(players, role) {
    return players.filter((p) => p.state.you.role === role);
}

/**
 * Plays a night where the Mafia kill `victim` (a TestClient) and the Doctor
 * protects someone else. Resolves once everyone sees the morning.
 */
export async function nightKill(players, victim) {
    const alive = players.filter((p) => p.state.you.alive);
    for (const p of alive) {
        const action = p.state.you.action;
        if (!action || action.current) continue;
        let targetId;
        if (action.type === "kill") targetId = victim.id;
        else targetId = action.targets.find((t) => t !== victim.id);
        const res = await p.request("nightAction", { targetId });
        if (!res.ok) throw new Error(`night action failed: ${res.error}`);
    }
    await Promise.all(players.filter((p) => p.socket.connected).map((p) => p.waitForState((s) => s.phase !== "night")));
}

/** Host advances until the phase is `phase`. */
export async function advanceTo(host, phase) {
    for (let i = 0; i < 6 && host.state.phase !== phase; i++) {
        const before = host.states.length;
        const res = await host.request("advancePhase", {});
        if (!res.ok) throw new Error(res.error);
        await waitFor(() => host.states.length > before);
    }
    if (host.state.phase !== phase) throw new Error(`could not reach ${phase}`);
}
