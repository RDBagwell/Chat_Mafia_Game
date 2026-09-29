import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startServer, setupGame, byRole, nightKill } from "../helpers.js";

let env;
beforeEach(async () => (env = await startServer()));
afterEach(async () => env.close());

describe("Phase 1 regressions (socket level)", () => {
    it("#1/#10 the host can advance phases from the client without a crash", async () => {
        const { host } = await setupGame(env, 5);
        expect(await host.request("advancePhase", {})).toEqual({ ok: true });
        await host.waitForState((s) => s.phase === "morning");
    });

    it("#7 game codes are not a fixed string", async () => {
        const a = await setupGame(env, 5, { start: false });
        const b = await setupGame(env, 5, { start: false });
        expect(a.gameId).not.toBe(b.gameId);
        expect(a.gameId).not.toBe("Test");
    });

    it("#8 a mid-game disconnect keeps the seat and role counts", async () => {
        const { host, players } = await setupGame(env, 5);
        players[4].socket.disconnect();
        await host.waitForState((s) => s.players.some((p) => !p.connected));
        expect(host.state.players).toHaveLength(5);
        expect(host.state.phase).toBe("night");
    });

    it("#9 state payloads carry events, so clients learn who died", async () => {
        const g = await setupGame(env, 5);
        const victim = byRole(g.players, "Villager")[0];
        await nightKill(g.players, victim);
        const observer = g.players.find((p) => p !== victim);
        await observer.waitForState((s) => s.events.some((e) => e.type === "night_result"));
        const ev = observer.state.events.find((e) => e.type === "night_result");
        expect(ev.data.killedId).toBe(victim.id);
    });
});

describe("seat switching", () => {
    it("creating a new game from a seated socket releases the old seat", async () => {
        const { players, host } = await setupGame(env, 5, { start: false });
        const mover = players[2];
        const res = await mover.request("createGame", { name: "Mover" });
        expect(res.ok).toBe(true);
        await host.waitForState((s) => s.players.length === 4);
    });
});
