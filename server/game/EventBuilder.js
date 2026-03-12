export class EventBuilder {

    buildNightEvent(game, result) {

        return {
            round: game.round,
            killType: "night",
            targeted: result.targeted,
            death: result.mafiaKilled,
            deathRole: result.mafiaKilled
                ? game.getPlayer(result.mafiaKilled)?.role
                : null,
            protected: result.doctorSaved,
            investigated: result.detectiveResult?.player ?? null,
            investigationResult: result.detectiveResult?.role ?? null,
            activePlayers: game.activePlayers(),
            winCondition: result.winCondition
        };

    }

    buildDayEvent(game, result) {

        return {
            round: game.round,
            killType: "day",
            executed: result.executed,
            executedRole: result.executed
                ? game.getPlayer(result.executed)?.role
                : null,
            voteBreakdown: result.voteBreakdown,
            tie: result.tie,
            activePlayers: game.activePlayers(),
            winCondition: result.winCondition
        };

    }

}