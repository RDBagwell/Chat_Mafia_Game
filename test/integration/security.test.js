import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startServer, setupGame, byRole, nightKill, advanceTo, waitFor, sleep } from "../helpers.js";

let env;
beforeEach(async () => {
    env = await startServer();
});
afterEach(async () => {
    await env.close();
});

/** Fresh 5-player game: 1 Mafia, 1 Detective, 1 Doctor, 2 Villagers. */
async function fiveGame() {
    const g = await setupGame(env, 5);
    const [mafia] = byRole(g.players, "Mafia");
    const villagers = byRole(g.players, "Villager");
    const [doctor] = byRole(g.players, "Doctor");
    const [detective] = byRole(g.players, "Detective");
    return { ...g, mafia, villagers, doctor, detective };
}

describe("chat channel permissions", () => {
    it("a non-Mafia player can't read or post Mafia chat", async () => {
        const { mafia, villagers, doctor } = await fiveGame();
        const secret = "mafia-secret-plan";
        expect(await mafia.request("chat", { channel: "mafia", text: secret })).toEqual({ ok: true });
        await mafia.waitForChat((m) => m.text === secret);

        for (const p of [...villagers, doctor]) {
            const res = await p.request("chat", { channel: "mafia", text: "let me in" });
            expect(res.ok).toBe(false);
            expect(p.state.you.readableChannels).not.toContain("mafia");
        }
        await sleep(50);
        for (const p of [...villagers, doctor]) {
            expect(JSON.stringify(p.raw)).not.toContain(secret);
            expect(JSON.stringify(p.raw)).not.toContain("let me in");
        }
    });

    it("general chat is read-only at night", async () => {
        const { villagers } = await fiveGame();
        const res = await villagers[0].request("chat", { channel: "general", text: "hello at night" });
        expect(res.ok).toBe(false);
    });

    it("a dead player can't post General or Mafia chat, vote or act; a living player never receives Dead chat", async () => {
        const { players, host, villagers, mafia } = await fiveGame();
        const victim = villagers[0];
        await nightKill(players, victim);
        await victim.waitForState((s) => !s.you.alive);
        expect(victim.state.you.observer).toBe(true);

        await advanceTo(host, "discussion");
        await victim.waitForState((s) => s.phase === "discussion");
        expect((await victim.request("chat", { channel: "general", text: "ghost says hi" })).ok).toBe(false);
        expect((await victim.request("chat", { channel: "mafia", text: "ghost in mafia" })).ok).toBe(false);
        const deadLine = "only-the-dead-hear-this";
        expect(await victim.request("chat", { channel: "dead", text: deadLine })).toEqual({ ok: true });

        // Observers can read everything, including Mafia chat.
        expect(victim.state.you.readableChannels).toEqual(expect.arrayContaining(["general", "mafia", "dead", "system"]));

        await advanceTo(host, "vote");
        await victim.waitForState((s) => s.phase === "vote");
        expect((await victim.request("vote", { targetId: mafia.id })).ok).toBe(false);
        expect((await victim.request("vote", { targetId: null })).ok).toBe(false);

        await sleep(50);
        for (const p of players.filter((p) => p !== victim)) {
            expect(JSON.stringify(p.raw)).not.toContain(deadLine);
            expect(p.state.you.readableChannels).not.toContain("dead");
        }
        // Dead players can't act at night either.
        await advanceTo(host, "night");
        await victim.waitForState((s) => s.phase === "night");
        expect(victim.state.you.action).toBeNull();
        expect((await victim.request("nightAction", { targetId: mafia.id })).ok).toBe(false);
    });

    it("the dead can read Mafia chat history once they die", async () => {
        const { players, mafia, villagers } = await fiveGame();
        await mafia.request("chat", { channel: "mafia", text: "we strike tonight" });
        const victim = villagers[0];
        await nightKill(players, victim);
        await victim.waitForState((s) => !s.you.alive && s.chat?.mafia);
        const texts = [...victim.states].reverse().find((s) => s.chat?.mafia).chat.mafia.map((m) => m.text);
        expect(texts).toContain("we strike tonight");
    });
});

describe("no hidden information leaks", () => {
    it("no payload to a living player contains another player's hidden role", async () => {
        const { players, host, villagers } = await fiveGame();
        await players[0].request("chat", { channel: "general", text: "x" }).catch(() => {});
        await nightKill(players, villagers[0]);
        await advanceTo(host, "vote");
        await sleep(50);

        for (const viewer of players) {
            for (const { event, payload } of viewer.raw) {
                if (event !== "state") continue;
                const me = payload.players.find((p) => p.id === payload.you.id);
                if (!payload.you.alive || payload.phase === "ended") continue;
                for (const p of payload.players) {
                    if (p.role === null) continue;
                    const allowed =
                        p.id === payload.you.id ||
                        (!p.alive && payload.settings.revealRoleOnDeath) ||
                        (payload.you.role === "Mafia" && p.role === "Mafia");
                    expect(allowed, `${me.name} saw ${p.name}'s role`).toBe(true);
                }
                if (payload.you.role !== "Mafia") expect(payload.mafiaVotes).toBeNull();
                expect(payload.nightActions).toBeNull();
                if (payload.you.role !== "Detective") expect(payload.you.investigations).toEqual([]);
                for (const e of payload.events) {
                    expect(["night_detail"]).not.toContain(e.type);
                    if (e.type === "investigation_result") expect(payload.you.role).toBe("Detective");
                }
            }
        }
    });

    it("the Detective privately learns only Mafia / Not Mafia", async () => {
        const { players, detective, mafia, villagers } = await fiveGame();
        await detective.request("nightAction", { targetId: mafia.id });
        await nightKill(players, villagers.find((v) => v !== detective) ?? villagers[0]);
        await detective.waitForState((s) => s.you.investigations.length === 1);
        expect(detective.state.you.investigations[0]).toEqual(
            expect.objectContaining({ targetId: mafia.id, result: "Mafia" })
        );
        for (const p of players.filter((p) => p !== detective && p.state.you.alive)) {
            expect(JSON.stringify(p.raw)).not.toContain('"result":"Mafia"');
        }
    });

    it("the morning report hides the target, the protection and the investigation", async () => {
        const { players, mafia, doctor, villagers } = await fiveGame();
        // Doctor saves the Mafia's target.
        const victim = villagers[0];
        await mafia.request("nightAction", { targetId: victim.id });
        await doctor.request("nightAction", { targetId: victim.id });
        const detective = byRole(players, "Detective")[0];
        await detective.request("nightAction", { targetId: mafia.id });
        await victim.waitForState((s) => s.phase === "morning");
        expect(victim.state.you.alive).toBe(true);
        const morning = victim.chats.filter((m) => m.channel === "system").map((m) => m.text).join("\n");
        expect(morning).toContain("nobody died");
        expect(morning).not.toContain("protect");
        expect(morning).not.toContain("saved");
        expect(morning).not.toContain("target");
    });
});

describe("host-only controls", () => {
    it("a non-host can't start the game, change settings, advance phases, add bots or kick", async () => {
        const { host, players } = await setupGame(env, 5, { start: false });
        const guest = players[1];
        expect((await guest.request("startGame", {})).ok).toBe(false);
        expect((await guest.request("updateSettings", { settings: { testMode: true } })).ok).toBe(false);
        expect((await guest.request("addBot", {})).ok).toBe(false);
        expect((await guest.request("kick", { playerId: players[2].id })).ok).toBe(false);
        expect(host.state.phase).toBe("lobby");

        await host.request("startGame", {});
        await guest.waitForState((s) => s.phase === "night");
        expect((await guest.request("advancePhase", {})).ok).toBe(false);
        expect((await guest.request("kick", { playerId: host.id })).ok).toBe(false);
        expect(guest.state.phase).toBe("night");
        expect(host.state.players.every((p) => !p.kicked)).toBe(true);
    });

    it("clients can't claim host rights with extra fields", async () => {
        const { players } = await setupGame(env, 5, { start: false });
        const res = await players[1].request("startGame", { isHost: true, gameId: "X" });
        expect(res.ok).toBe(false);
    });
});

describe("kick", () => {
    it("a kicked player is disconnected and can't rejoin with their token or name", async () => {
        const { host, players, gameId } = await setupGame(env, 5, { start: false });
        const target = players[2];
        const name = target.state.you.name;
        expect(await host.request("kick", { playerId: target.id })).toEqual({ ok: true });
        await waitFor(() => target.ended?.reason === "kicked");
        await waitFor(() => !target.socket.connected);
        await host.waitForChat((m) => m.text.includes("kicked"));

        const again = env.connect();
        await again.connected;
        expect((await again.request("resume", { gameId, token: target.token })).ok).toBe(false);
        expect((await again.request("joinGame", { gameId, name })).ok).toBe(false);
        expect((await again.request("joinGame", { gameId, name: name.toUpperCase() })).ok).toBe(false);
        expect((await again.request("joinGame", { gameId, name: "Fresh Face" })).ok).toBe(true);
    });

    it("kicking mid-game counts as a death and re-checks the win condition", async () => {
        const { host, mafia, players } = await fiveGame();
        if (mafia === host) return; // host can't kick themself; covered by unit tests
        await host.request("kick", { playerId: mafia.id });
        await host.waitForState((s) => s.phase === "ended");
        expect(host.state.winner.team).toBe("town");
        expect(players.length).toBe(5);
    });
});

describe("validation", () => {
    it("rejects unknown fields, wrong types and unknown events", async () => {
        const { players, host } = await setupGame(env, 5);
        const p = players[1];
        expect((await p.request("chat", { channel: "general", text: "hi", extra: 1 })).ok).toBe(false);
        expect((await p.request("chat", { channel: "general", text: 42 })).ok).toBe(false);
        expect((await p.request("chat", { channel: "secret", text: "hi" })).ok).toBe(false);
        expect((await p.request("chat", "just a string")).ok).toBe(false);
        expect((await p.request("nightAction", { targetId: "../../etc" })).ok).toBe(false);
        expect((await host.request("updateSettings", { settings: { nightSeconds: 1 } })).ok).toBe(false);
        p.socket.emit("__proto__", {});
        p.socket.emit("hackTheGibson", { x: 1 });
        await waitFor(() => p.errors.length >= 2);
        expect(p.errors.every((e) => e.message === "Invalid request.")).toBe(true);
    });

    it("rejects oversized payloads by disconnecting the socket", async () => {
        const { players } = await setupGame(env, 5, { start: false });
        const p = players[1];
        p.socket.emit("chat", { channel: "general", text: "x".repeat(10_000) });
        await waitFor(() => !p.socket.connected);
    });

    it("rejects chat over 500 characters and empty chat", async () => {
        const { players } = await setupGame(env, 5, { start: false });
        expect((await players[1].request("chat", { channel: "general", text: "y".repeat(501) })).ok).toBe(false);
        expect((await players[1].request("chat", { channel: "general", text: "   " })).ok).toBe(false);
        expect((await players[1].request("chat", { channel: "general", text: "\u0000\u0007" })).ok).toBe(false);
    });

    it("rejects bad targets: Mafia teammate, the dead, self-investigation, Doctor repeat", async () => {
        const g = await setupGame(env, 7); // 2 Mafia
        const [m1, m2] = byRole(g.players, "Mafia");
        const [doctor] = byRole(g.players, "Doctor");
        const [detective] = byRole(g.players, "Detective");
        const villagers = byRole(g.players, "Villager");

        expect((await m1.request("nightAction", { targetId: m2.id })).error).toBe("That's not a valid target.");
        expect((await detective.request("nightAction", { targetId: detective.id })).ok).toBe(false);
        expect((await villagers[0].request("nightAction", { targetId: m1.id })).ok).toBe(false);
        expect((await doctor.request("nightAction", { targetId: "p_0000000000000000" })).ok).toBe(false);

        // Night 1: Doctor protects villagers[1]; Mafia kill villagers[0].
        await doctor.request("nightAction", { targetId: villagers[1].id });
        await detective.request("nightAction", { targetId: villagers[1].id });
        await m1.request("nightAction", { targetId: villagers[0].id });
        await m2.request("nightAction", { targetId: villagers[0].id });
        await g.host.waitForState((s) => s.phase === "morning");
        await advanceTo(g.host, "vote");
        await advanceTo(g.host, "night");
        await doctor.waitForState((s) => s.phase === "night");

        expect(doctor.state.you.action.targets).not.toContain(villagers[1].id);
        expect((await doctor.request("nightAction", { targetId: villagers[1].id })).ok).toBe(false);
        expect((await doctor.request("nightAction", { targetId: doctor.id })).ok).toBe(true);
        expect((await m1.request("nightAction", { targetId: villagers[0].id })).ok).toBe(false); // dead
    });

    it("rejects invalid display names", async () => {
        const c = env.connect();
        await c.connected;
        for (const name of ["a", "x".repeat(21), "System", "HOST", "sys tem", "<img src=x>", "Ѕystem", "bad\u0000name"]) {
            expect((await c.request("createGame", { name })).ok, name).toBe(false);
        }
    });
});

describe("XSS payloads are carried as inert data", () => {
    it("delivers <script> and <img onerror> chat unchanged as plain text fields", async () => {
        const { players } = await setupGame(env, 5, { start: false });
        const payloads = ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>"];
        for (const text of payloads) await players[1].request("chat", { channel: "general", text });
        for (const text of payloads) {
            const m = await players[2].waitForChat((msg) => msg.text === text);
            expect(typeof m.text).toBe("string");
            expect(m.html).toBeUndefined();
        }
    });
});

describe("sessions and reconnects", () => {
    it("a mid-game disconnect keeps the seat; resume restores it with a fresh snapshot", async () => {
        const { players, host, gameId } = await fiveGame();
        const p = players[3];
        const { id, role } = p.state.you;
        p.socket.disconnect();
        await host.waitForState((s) => s.players.find((x) => x.id === id)?.connected === false);
        expect(host.state.players).toHaveLength(5);

        const back = env.connect();
        await back.connected;
        const res = await back.request("resume", { gameId, token: p.token });
        expect(res).toEqual({ ok: true, gameId, playerId: id });
        await back.waitForState((s) => s.you.id === id);
        expect(back.state.you.role).toBe(role);
        expect(back.state.chat).toBeDefined();
    });

    it("a forged or wrong token can't take a seat", async () => {
        const { gameId } = await setupGame(env, 5, { start: false });
        const c = env.connect();
        await c.connected;
        expect((await c.request("resume", { gameId, token: "A".repeat(43) })).ok).toBe(false);
    });

    it("rejects connections from origins outside the allowlist", async () => {
        const bad = env.connect({ origin: "https://evil.example" });
        await expect(bad.connected).rejects.toBeTruthy();
    });

    it("transfers host when the host is gone for longer than the grace period", async () => {
        await env.close();
        env = await startServer({ config: { hostTransferMs: 100 } });
        const { host, players } = await setupGame(env, 5, { start: false });
        host.socket.disconnect();
        await players[1].waitForState((s) => s.hostId === players[1].id, 3000);
        expect(players[1].state.you.isHost).toBe(true);
    });
});

describe("rate limits", () => {
    it("limits chat to 5 messages per 5 seconds per player", async () => {
        const { players } = await setupGame(env, 5, { start: false });
        const results = [];
        for (let i = 0; i < 8; i++) results.push(await players[1].request("chat", { channel: "general", text: `m${i}` }));
        expect(results.filter((r) => r.ok)).toHaveLength(5);
        expect(results.at(-1).error).toMatch(/too fast/);
    });

    it("limits join attempts per IP so codes can't be brute-forced", async () => {
        await env.close();
        env = await startServer({ config: { limits: { joinPerIp: { capacity: 3, windowMs: 60000 } } } });
        const c = env.connect();
        await c.connected;
        const results = [];
        for (let i = 0; i < 5; i++) results.push(await c.request("joinGame", { gameId: "ABCDEF", name: "Guesser" }));
        expect(results.slice(3).every((r) => /too fast/.test(r.error))).toBe(true);
    });
});
