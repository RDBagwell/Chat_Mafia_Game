import { describe, it, expect, afterEach } from "vitest";
import { startServer, waitFor } from "../helpers.js";

let env;
afterEach(async () => env?.close());

/**
 * A single human host plus RandomBots plays a whole game. The host acts
 * randomly from its own view and advances the talk phases, so the game has
 * to reach a win through the real rules.
 */
async function playFullGame(botCount) {
    env = await startServer({ config: { bots: { minDelayMs: 0, maxDelayMs: 5, chatChance: 1 } } });
    const host = env.connect();
    await host.connected;
    const created = await host.request("createGame", { name: "Alice" });
    for (let i = 0; i < botCount; i++) expect(await host.request("addBot", {})).toEqual({ ok: true });
    await host.waitForState((s) => s.players.length === botCount + 1);
    expect(host.state.players.filter((p) => p.isBot)).toHaveLength(botCount);
    expect(await host.request("startGame", {})).toEqual({ ok: true });

    const seen = new Set();
    await waitFor(() => {
        const s = host.state;
        if (s.phase === "ended") return true;
        const key = `${s.phase}:${s.round}:${JSON.stringify(s.you.action?.current ?? "")}:${s.you.action?.hasVoted}`;
        if (!seen.has(key)) {
            seen.add(key);
            const action = s.you.action;
            if (action && !action.current && !action.hasVoted && action.targets.length) {
                const targetId = action.targets[Math.floor(Math.random() * action.targets.length)];
                host.request(action.type === "vote" ? "vote" : "nightAction", { targetId });
            } else if (s.phase === "morning" || s.phase === "discussion") {
                host.request("advancePhase", {});
            } else if (!s.you.alive || !action) {
                // Observer host still drives the clock.
                setTimeout(() => host.state.phase === s.phase && host.state.round === s.round && host.request("advancePhase", {}), 30);
            }
        }
        return false;
    }, 20000, "game over");
    return { host, gameId: created.gameId };
}

describe("RandomBot", () => {
    it("a full game with RandomBots runs to a win", async () => {
        const { host } = await playFullGame(6);
        expect(["town", "mafia"]).toContain(host.state.winner.team);
        expect(host.state.players.every((p) => p.role)).toBe(true);
        expect(host.chats.some((m) => m.from && m.from.name.startsWith("Bot "))).toBe(true);
    }, 30000);

    it("the host can start a new game with the same lobby afterwards", async () => {
        const { host } = await playFullGame(4);
        expect(await host.request("newGame", {})).toEqual({ ok: true });
        await host.waitForState((s) => s.phase === "lobby");
        expect(host.state.players).toHaveLength(5);
        expect(host.state.players.every((p) => p.alive && p.role === null || p.id === host.state.you.id)).toBe(true);
        expect(host.state.chat.mafia).toBeUndefined();
    }, 30000);

    it("the lobby is capped at the maximum player count", async () => {
        env = await startServer();
        const host = env.connect();
        await host.connected;
        await host.request("createGame", { name: "Alice" });
        const results = [];
        for (let i = 0; i < 16; i++) results.push(await host.request("addBot", {}));
        expect(results.filter((r) => r.ok)).toHaveLength(15);
    });
});

describe("secrets", () => {
    it("the Anthropic API key never appears in any payload sent to a client", async () => {
        const key = "sk-ant-test-DO-NOT-LEAK-123456";
        env = await startServer({ config: { llm: { ...(await import("../../server/config.js")).loadConfig({}).llm, enabled: true, apiKey: key } } });
        const host = env.connect();
        await host.connected;
        await host.request("createGame", { name: "Alice" });
        for (let i = 0; i < 4; i++) await host.request("addBot", {});
        await host.request("startGame", {});
        await host.request("chat", { channel: "nope", text: "x" });
        // Bots may resolve the night instantly, so wait for "game started", not a specific phase.
        await host.waitForState((s) => s.phase !== "lobby");
        expect(JSON.stringify(host.raw)).not.toContain(key);
    });
});
