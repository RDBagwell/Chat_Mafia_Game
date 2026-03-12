export class DayResolver {

    resolve(game) {

        const alive = game.players.filter(p => p.alive);

        const votes = {};

        for (const voter of alive) {

            const targets = alive.filter(p => p.name !== voter.name);

            if (!targets.length) continue;

            const target =
                targets[Math.floor(Math.random() * targets.length)];

            votes[voter.name] = target.name;

        }

        const voteCount = {};

        Object.values(votes).forEach(target => {
            voteCount[target] = (voteCount[target] || 0) + 1;
        });

        const entries = Object.entries(voteCount);

        if (!entries.length) {

            return {
                executed: null,
                voteBreakdown: voteCount,
                tie: false,
                winCondition: null
            };

        }

        entries.sort((a, b) => b[1] - a[1]);

        const highest = entries[0][1];

        const top = entries
            .filter(([_, count]) => count === highest)
            .map(([name]) => name);

        let executed = null;
        let tie = false;

        if (top.length > 1) {

            tie = true;

        } else {

            const player = game.getPlayer(top[0]);

            if (player) {
                player.alive = false;
                executed = player.name;
            }

        }

        const winCondition = game.checkWinCondition();

        return {
            executed,
            voteBreakdown: voteCount,
            tie,
            winCondition
        };

    }

}