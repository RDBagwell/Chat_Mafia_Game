/**
 * Builds structured event objects. Every entry in game.events comes from here,
 * so events always share one shape:
 *   { seq, type, round, phase, ts, visibility, data }
 */
export class EventBuilder {
    build(game, type, data = {}, visibility = { public: true }) {
        return {
            seq: ++game.eventSeq,
            type,
            round: game.round,
            phase: game.phase,
            ts: Date.now(),
            visibility,
            data,
        };
    }

    /**
     * Public night summary: only who died. Who the Mafia targeted, who the
     * Doctor protected and what the Detective learned are never public.
     */
    buildNightEvent(game, result) {
        const victim = result.killedId ? game.getPlayer(result.killedId) : null;
        return this.build(game, "night_result", {
            killedId: victim?.id ?? null,
            killedName: victim?.name ?? null,
            killedRole: victim && victim.revealed ? victim.role : null,
        });
    }

    /** Observer-only (dead players) record of what actually happened at night. */
    buildNightDetailEvent(game, result) {
        return this.build(
            game,
            "night_detail",
            {
                targetedId: result.targetedId,
                protectedId: result.protectedId,
                saved: result.saved,
                investigation: result.investigation,
            },
            { dead: true }
        );
    }

    buildDayEvent(game, result) {
        const executed = result.executedId ? game.getPlayer(result.executedId) : null;
        return this.build(game, "vote_result", {
            executedId: executed?.id ?? null,
            executedName: executed?.name ?? null,
            executedRole: executed && executed.revealed ? executed.role : null,
            tally: result.tally,
            tie: result.tie,
            skipped: result.skipped,
        });
    }
}
