import { NightResolver } from "./NightResolver.js";
import { DayResolver } from "./DayResolver.js";
import { PHASES, TEAMS } from "./constants.js";

/**
 * Drives the phase cycle:
 *   lobby → (night → morning → discussion → vote)* → ended
 *
 * Pure with respect to time: callers pass `now`, and phaseEndsAt is only
 * recorded here. GameSession owns the actual timers.
 */
export class PhaseEngine {
    constructor() {
        this.nightResolver = new NightResolver();
        this.dayResolver = new DayResolver();
    }

    durationFor(game, phase) {
        const s = game.settings;
        switch (phase) {
            case PHASES.NIGHT: return s.nightSeconds * 1000;
            case PHASES.MORNING: return s.morningSeconds * 1000;
            case PHASES.DISCUSSION: return s.discussionSeconds * 1000;
            case PHASES.VOTE: return s.voteSeconds * 1000;
            default: return null;
        }
    }

    enter(game, phase, now = Date.now()) {
        const duration = this.durationFor(game, phase);
        game.setPhase(phase, duration === null ? null : now + duration);
    }

    startGame(game, now = Date.now()) {
        game.assignRoles();
        game.winner = null;
        game.round = 0;
        game.lastProtectedId = null;
        game.resetRoundState();
        game.addEvent("game_started", { playerCount: game.players.length, roleCounts: game.roleCounts });
        game.nextRound();
        this.enter(game, PHASES.NIGHT, now);
    }

    /** Resolves the night and moves to the morning report (or game over). */
    runNight(game, now = Date.now()) {
        const result = this.nightResolver.resolve(game);
        game.events.push(game.eventBuilder.buildNightDetailEvent(game, result));
        game.events.push(game.eventBuilder.buildNightEvent(game, result));
        if (result.investigation) {
            game.addEvent("investigation_result", result.investigation, {
                players: [result.investigation.detectiveId],
                dead: true,
            });
        }
        game.resetRoundState();
        if (result.winner) this.endGame(game);
        else this.enter(game, PHASES.MORNING, now);
        return result;
    }

    /** Resolves the day vote and moves to the next night (or game over). */
    runDay(game, now = Date.now()) {
        const result = this.dayResolver.resolve(game);
        game.events.push(game.eventBuilder.buildDayEvent(game, result));
        game.resetRoundState();
        if (result.winner) {
            this.endGame(game);
        } else {
            game.nextRound();
            this.enter(game, PHASES.NIGHT, now);
        }
        return result;
    }

    endGame(game) {
        game.checkWinCondition();
        game.setPhase(PHASES.ENDED, null);
        game.addEvent("game_over", {
            winner: game.winner?.team ?? null,
            reason: game.winner?.reason ?? null,
            roles: game.players.map((p) => ({ id: p.id, name: p.name, role: p.role })),
        });
    }

    /**
     * Moves to the next phase, resolving whatever the current phase decides.
     * Returns { from, to, result } or null when there is nothing to advance.
     */
    advance(game, now = Date.now()) {
        const from = game.phase;
        let result = null;
        switch (from) {
            case PHASES.NIGHT:
                result = this.runNight(game, now);
                break;
            case PHASES.MORNING:
                this.enter(game, PHASES.DISCUSSION, now);
                break;
            case PHASES.DISCUSSION:
                this.enter(game, PHASES.VOTE, now);
                break;
            case PHASES.VOTE:
                result = this.runDay(game, now);
                break;
            default:
                return null;
        }
        return { from, to: game.phase, result };
    }

    /** Ends the game immediately if a win condition holds (e.g. after a kick). */
    checkForWin(game) {
        if (game.phase === PHASES.LOBBY || game.phase === PHASES.ENDED) return false;
        if (!game.checkWinCondition()) return false;
        this.endGame(game);
        return true;
    }
}

export { TEAMS };
