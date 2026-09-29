import { describe, it, expect } from "vitest";
import { Game, DEFAULT_SETTINGS } from "../../server/game/Game.js";
import { ROLES, PHASES, TEAMS } from "../../server/game/constants.js";
import { getViewFor, availableAction, canSeeRole } from "../../server/game/view.js";
import { canRead, canWrite } from "../../server/game/channels.js";
import { sanitizeChat, sanitizeName, normalizeGameCode, validateEvent } from "../../server/security/validation.js";

const { MAFIA: M, DETECTIVE: D, DOCTOR: DOC, VILLAGER: V } = ROLES;

function makeGame(roles, phase = PHASES.NIGHT) {
    const game = new Game("TESTAA");
    roles.forEach((role, i) => (game.addPlayer({ name: `P${i}` }).role = role));
    game.round = 1;
    game.phase = phase;
    return game;
}

describe("role assignment", () => {
    it.each([
        [4, 1], [5, 1], [6, 1], [7, 2], [10, 2], [11, 3], [14, 4], [16, 4],
    ])("%i players get %i Mafia by default", (n, mafia) => {
        const pool = Game.buildRolePool(n, DEFAULT_SETTINGS);
        expect(pool.filter((r) => r === M)).toHaveLength(mafia);
        expect(pool.filter((r) => r === D)).toHaveLength(1);
        expect(pool.filter((r) => r === DOC)).toHaveLength(1);
        expect(pool).toHaveLength(n);
    });

    it("enforces Mafia under half and at least one Villager", () => {
        expect(Game.buildRolePool(6, { ...DEFAULT_SETTINGS, mafiaCount: 3 })).toMatch(/fewer than half/);
        expect(Game.buildRolePool(3, DEFAULT_SETTINGS)).toMatch(/Villager/);
        expect(Game.buildRolePool(5, { ...DEFAULT_SETTINGS, mafiaCount: 2 })).toEqual(expect.any(Array));
    });

    it("requires 5 players, or 4 in test mode", () => {
        const game = new Game("X");
        for (let i = 0; i < 4; i++) game.addPlayer({ name: `P${i}` });
        expect(game.validateStart()).toMatch(/5 players/);
        game.settings.testMode = true;
        expect(game.validateStart()).toBeNull();
    });

    it("assigns every role in the pool exactly once, in varying order", () => {
        const orders = new Set();
        for (let i = 0; i < 30; i++) {
            const game = new Game("X");
            for (let j = 0; j < 8; j++) game.addPlayer({ name: `P${j}` });
            game.assignRoles();
            expect(game.players.map((p) => p.role).sort()).toEqual(Game.buildRolePool(8, DEFAULT_SETTINGS).sort());
            orders.add(game.players.map((p) => p.role).join());
        }
        expect(orders.size).toBeGreaterThan(1);
    });
});

describe("NightResolver", () => {
    it("kills the Mafia's plurality choice", () => {
        const game = makeGame([M, M, M, V, V, V, V, D]);
        const [m1, m2, m3, v1, v2] = game.players;
        game.night.mafiaVotes.set(m1.id, v1.id).set(m2.id, v1.id).set(m3.id, v2.id);
        const r = game.phaseRunner.nightResolver.resolve(game);
        expect(r.killedId).toBe(v1.id);
        expect(v1.alive).toBe(false);
    });

    it("breaks Mafia ties randomly among the tied targets only", () => {
        const seen = new Set();
        for (let i = 0; i < 60; i++) {
            const game = makeGame([M, M, V, V, V, V, D]);
            const [m1, m2, v1, v2] = game.players;
            game.night.mafiaVotes.set(m1.id, v1.id).set(m2.id, v2.id);
            const r = game.phaseRunner.nightResolver.resolve(game);
            expect([v1.id, v2.id]).toContain(r.killedId);
            seen.add(r.killedId === v1.id ? "v1" : "v2");
        }
        expect(seen.size).toBe(2);
    });

    it("the Doctor saves the target", () => {
        const game = makeGame([M, DOC, V, V, V]);
        const [m, doc, v1] = game.players;
        game.night.mafiaVotes.set(m.id, v1.id);
        game.night.doctorTarget = { actorId: doc.id, targetId: v1.id };
        const r = game.phaseRunner.nightResolver.resolve(game);
        expect(r.saved).toBe(true);
        expect(r.killedId).toBeNull();
        expect(game.lastProtectedId).toBe(v1.id);
    });

    it("no Mafia vote means no kill", () => {
        const game = makeGame([M, DOC, V, V, V]);
        expect(game.phaseRunner.nightResolver.resolve(game).killedId).toBeNull();
    });

    it("the Detective learns Mafia / Not Mafia, never the exact role", () => {
        const game = makeGame([M, D, DOC, V, V]);
        const [m, det, doc] = game.players;
        game.night.detectiveTarget = { actorId: det.id, targetId: doc.id };
        game.phaseRunner.nightResolver.resolve(game);
        game.night.detectiveTarget = { actorId: det.id, targetId: m.id };
        game.phaseRunner.nightResolver.resolve(game);
        expect(det.investigations.map((i) => i.result)).toEqual(["Not Mafia", "Mafia"]);
        expect(JSON.stringify(det.investigations)).not.toContain("Doctor");
    });
});

describe("Doctor repeat rule", () => {
    it("can protect themself but not the same player two nights in a row", () => {
        const game = makeGame([M, DOC, V, V, V]);
        const [, doc, v1] = game.players;
        expect(availableAction(game, doc).targets).toContain(doc.id);
        game.lastProtectedId = v1.id;
        expect(availableAction(game, doc).targets).not.toContain(v1.id);
        game.lastProtectedId = null;
        expect(availableAction(game, doc).targets).toContain(v1.id);
    });

    it("resets once a night passes without protecting that player", () => {
        const game = makeGame([M, DOC, V, V, V]);
        const [, doc, v1] = game.players;
        game.night.doctorTarget = { actorId: doc.id, targetId: v1.id };
        game.phaseRunner.nightResolver.resolve(game);
        game.resetRoundState();
        expect(availableAction(game, doc).targets).not.toContain(v1.id);
        game.phaseRunner.nightResolver.resolve(game); // no protection this night
        expect(availableAction(game, doc).targets).toContain(v1.id);
    });
});

describe("DayResolver", () => {
    it("executes the plurality target", () => {
        const game = makeGame([M, D, DOC, V, V], PHASES.VOTE);
        const [m, d, doc, v1, v2] = game.players;
        game.votes.set(d.id, m.id).set(doc.id, m.id).set(v1.id, v2.id);
        const r = game.phaseRunner.dayResolver.resolve(game);
        expect(r.executedId).toBe(m.id);
        expect(r.winner.team).toBe(TEAMS.TOWN);
    });

    it("a tie executes nobody", () => {
        const game = makeGame([M, D, DOC, V, V], PHASES.VOTE);
        const [m, d, doc, v1] = game.players;
        game.votes.set(d.id, m.id).set(doc.id, v1.id);
        const r = game.phaseRunner.dayResolver.resolve(game);
        expect(r).toEqual(expect.objectContaining({ executedId: null, tie: true }));
    });

    it("skip winning executes nobody; a tie with skip executes nobody", () => {
        const game = makeGame([M, D, DOC, V, V], PHASES.VOTE);
        const [m, d, doc, v1] = game.players;
        game.votes.set(d.id, null).set(doc.id, null).set(v1.id, m.id);
        expect(game.phaseRunner.dayResolver.resolve(game)).toEqual(expect.objectContaining({ executedId: null, skipped: true }));
        game.votes.clear();
        game.votes.set(d.id, null).set(v1.id, m.id);
        expect(game.phaseRunner.dayResolver.resolve(game)).toEqual(expect.objectContaining({ executedId: null, tie: true }));
    });

    it("votes from or for dead players don't count", () => {
        const game = makeGame([M, D, DOC, V, V], PHASES.VOTE);
        const [m, d, doc, v1] = game.players;
        game.votes.set(d.id, m.id).set(doc.id, v1.id).set(v1.id, doc.id);
        game.killPlayer(d.id, "test");
        const r = game.phaseRunner.dayResolver.resolve(game);
        expect(r.tally[m.id]).toBeUndefined();
    });
});

describe("win conditions", () => {
    it("town wins when all Mafia are dead", () => {
        const game = makeGame([M, V, V, V, V]);
        game.killPlayer(game.players[0].id);
        expect(game.checkWinCondition().team).toBe(TEAMS.TOWN);
    });

    it("Mafia win at parity", () => {
        const game = makeGame([M, M, V, V, V]);
        expect(game.checkWinCondition()).toBeNull();
        game.killPlayer(game.players[2].id);
        expect(game.checkWinCondition().team).toBe(TEAMS.MAFIA);
        expect(game.winner.team).toBe(TEAMS.MAFIA);
    });

    it("the engine ends the game after a winning night", () => {
        const game = makeGame([M, V, DOC]);
        const [m, v] = game.players;
        game.night.mafiaVotes.set(m.id, v.id);
        game.phaseRunner.advance(game);
        expect(game.phase).toBe(PHASES.ENDED);
        expect(game.events.find((e) => e.type === "game_over").data.roles).toHaveLength(3);
    });

    it("the full cycle is night → morning → discussion → vote → night (round + 1)", () => {
        const game = makeGame([M, D, DOC, V, V]);
        const phases = [];
        for (let i = 0; i < 4; i++) phases.push(game.phaseRunner.advance(game).to);
        expect(phases).toEqual([PHASES.MORNING, PHASES.DISCUSSION, PHASES.VOTE, PHASES.NIGHT]);
        expect(game.round).toBe(2);
    });
});

describe("getViewFor and channels", () => {
    it("shows a living Villager only their own role", () => {
        const game = makeGame([M, D, DOC, V, V]);
        const villager = game.players[3];
        const view = getViewFor(game, villager.id);
        expect(view.players.filter((p) => p.role !== null).map((p) => p.id)).toEqual([villager.id]);
        expect(view.mafiaVotes).toBeNull();
        expect(view.nightActions).toBeNull();
    });

    it("shows Mafia their teammates, and the dead everything", () => {
        const game = makeGame([M, M, D, DOC, V, V, V]);
        const [m1, m2, , , v1] = game.players;
        expect(getViewFor(game, m1.id).players.find((p) => p.id === m2.id).role).toBe(M);
        expect(getViewFor(game, m1.id).players.find((p) => p.id === v1.id).role).toBeNull();
        game.killPlayer(v1.id);
        expect(getViewFor(game, v1.id).players.every((p) => p.role)).toBe(true);
    });

    it("respects the reveal-on-death setting", () => {
        const game = makeGame([M, D, DOC, V, V]);
        game.settings.revealRoleOnDeath = false;
        const [, d, , v1] = game.players;
        game.killPlayer(d.id);
        expect(canSeeRole(game, v1, d)).toBe(false);
        game.phase = PHASES.ENDED;
        expect(canSeeRole(game, v1, d)).toBe(true);
    });

    it("channel matrix", () => {
        const game = makeGame([M, V, V, D, DOC]);
        const [m, v, dead] = game.players;
        game.killPlayer(dead.id);
        game.phase = PHASES.NIGHT;
        expect([canRead(game, v, "mafia"), canWrite(game, v, "general")]).toEqual([false, false]);
        expect([canRead(game, m, "mafia"), canWrite(game, m, "mafia")]).toEqual([true, true]);
        expect([canRead(game, dead, "mafia"), canWrite(game, dead, "mafia")]).toEqual([true, false]);
        expect([canRead(game, dead, "dead"), canWrite(game, dead, "dead")]).toEqual([true, true]);
        expect([canRead(game, v, "dead"), canWrite(game, v, "system")]).toEqual([false, false]);
        game.phase = PHASES.DISCUSSION;
        expect([canWrite(game, v, "general"), canWrite(game, dead, "general")]).toEqual([true, false]);
    });
});

describe("input sanitising", () => {
    it("names", () => {
        expect(sanitizeName("  Bob   Smith ")).toEqual({ ok: true, value: "Bob Smith" });
        for (const bad of ["B", "System", "the host", "Host_1", "<b>", "Ѕystem", "é"]) expect(sanitizeName(bad).ok, bad).toBe(false);
    });

    it("chat strips control and bidi characters", () => {
        expect(sanitizeChat("hi‮there\u0007\n").value).toBe("hithere");
        expect(sanitizeChat("x".repeat(501)).ok).toBe(false);
    });

    it("game codes", () => {
        expect(normalizeGameCode(" abc-def ")).toBe("ABCDEF");
        expect(normalizeGameCode("ABCDE0")).toBeNull();
    });

    it("unknown events and fields are rejected", () => {
        expect(validateEvent("toString", {}).ok).toBe(false);
        expect(validateEvent("constructor", {}).ok).toBe(false);
        expect(validateEvent("vote", { targetId: null, extra: 1 }).ok).toBe(false);
    });
});
