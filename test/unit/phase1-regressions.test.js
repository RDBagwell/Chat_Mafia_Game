import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { Game } from "../../server/game/Game.js";
import { ROLES, PHASES, TEAMS } from "../../server/game/constants.js";
import { GAME_CODE_ALPHABET, generateGameCode } from "../../server/security/random.js";

function makeGame(roles) {
    const game = new Game("TEST01");
    roles.forEach((role, i) => {
        const p = game.addPlayer({ name: `P${i}` });
        p.role = role;
    });
    game.round = 1;
    game.phase = PHASES.NIGHT;
    return game;
}

const [M, D, DOC, V] = [ROLES.MAFIA, ROLES.DETECTIVE, ROLES.DOCTOR, ROLES.VILLAGER];

describe("Phase 1 regressions", () => {
    it("#1 the phase engine lives on game.phaseRunner and advancing does not crash", () => {
        const game = makeGame([M, D, DOC, V, V]);
        expect(typeof game.phase).toBe("string");
        expect(() => game.phaseRunner.advance(game)).not.toThrow();
        expect(game.phase).toBe(PHASES.MORNING);
    });

    it("#2 activePlayers() exists and there is no activatePlayers()", () => {
        const game = makeGame([M, V, V, V, V]);
        expect(game.activePlayers()).toHaveLength(5);
        expect(game.activatePlayers).toBeUndefined();
    });

    it("#3 the Mafia never kills its own team; targets are alive non-Mafia", () => {
        const game = makeGame([M, M, V, V, V, V, V]);
        const targets = game.mafiaTargets().map((p) => p.role);
        expect(targets.every((r) => r !== M)).toBe(true);
        // A Mafia vote for a teammate is ignored by the resolver.
        const [m1, m2] = game.players;
        game.night.mafiaVotes.set(m1.id, m2.id);
        const result = game.phaseRunner.nightResolver.resolve(game);
        expect(result.killedId).toBeNull();
        expect(m2.alive).toBe(true);
    });

    it("#4 winner is set on a win and the round advances after the day", () => {
        const game = makeGame([M, D, DOC, V, V]);
        game.phase = PHASES.VOTE;
        game.votes.set(game.players[1].id, game.players[3].id);
        game.phaseRunner.advance(game);
        expect(game.round).toBe(2);
        game.killPlayer(game.players[0].id, "test");
        expect(game.checkWinCondition()).toEqual(expect.objectContaining({ team: TEAMS.TOWN }));
        expect(game.winner.team).toBe(TEAMS.TOWN);
    });

    it("#5 dead Doctors and Detectives don't act", () => {
        const game = makeGame([M, D, DOC, V, V]);
        const [mafia, det, doc, v1] = game.players;
        game.night.mafiaVotes.set(mafia.id, v1.id);
        game.night.doctorTarget = { actorId: doc.id, targetId: v1.id };
        game.night.detectiveTarget = { actorId: det.id, targetId: mafia.id };
        doc.alive = false;
        det.alive = false;
        const result = game.phaseRunner.nightResolver.resolve(game);
        expect(result.protectedId).toBeNull();
        expect(result.investigation).toBeNull();
        expect(result.killedId).toBe(v1.id);
    });

    it("#6 every event is a structured object", () => {
        const game = makeGame([M, D, DOC, V, V]);
        game.phaseRunner.advance(game);
        game.phaseRunner.advance(game);
        game.nextRound();
        expect(game.events.length).toBeGreaterThan(0);
        for (const e of game.events) {
            expect(typeof e).toBe("object");
            expect(e).toEqual(expect.objectContaining({ seq: expect.any(Number), type: expect.any(String), visibility: expect.any(Object) }));
        }
    });

    it("#7 game codes are random, 6+ chars from an unambiguous alphabet", () => {
        const codes = new Set(Array.from({ length: 200 }, () => generateGameCode()));
        expect(codes.size).toBe(200);
        for (const code of codes) {
            expect(code.length).toBeGreaterThanOrEqual(6);
            for (const ch of code) expect(GAME_CODE_ALPHABET).toContain(ch);
        }
        expect(GAME_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    });

    it("#11 SocketController file name has no space", () => {
        expect(fs.existsSync(new URL("../../server/sockets/SocketController.js", import.meta.url))).toBe(true);
        expect(fs.existsSync(new URL("../../server/sockets/SocketController .js", import.meta.url))).toBe(false);
    });

    it("#12 the memory.js stub is gone", () => {
        expect(fs.existsSync(new URL("../../server/agents/memory.js", import.meta.url))).toBe(false);
    });

    it("#13 there is a single package.json at the repo root", () => {
        expect(fs.existsSync(new URL("../../package.json", import.meta.url))).toBe(true);
        expect(fs.existsSync(new URL("../../server/package.json", import.meta.url))).toBe(false);
        expect(fs.existsSync(new URL("../../server/package-lock.json", import.meta.url))).toBe(false);
    });
});
