/**
 * Tallies the day vote. Each living player's vote is a player id or null
 * (skip). The most votes wins; a tie at the top, or "skip" winning, means
 * nobody is executed.
 */
export class DayResolver {
    tally(game) {
        const tally = { skip: 0 };
        for (const [voterId, targetId] of game.votes) {
            const voter = game.getPlayer(voterId);
            if (!voter?.alive) continue;
            if (targetId === null) {
                tally.skip++;
                continue;
            }
            const target = game.getPlayer(targetId);
            if (!target?.alive) continue;
            tally[targetId] = (tally[targetId] || 0) + 1;
        }
        return tally;
    }

    resolve(game) {
        const tally = this.tally(game);
        const entries = Object.entries(tally).filter(([, c]) => c > 0);

        let executedId = null;
        let tie = false;
        let skipped = false;

        if (entries.length) {
            const max = Math.max(...entries.map(([, c]) => c));
            const top = entries.filter(([, c]) => c === max).map(([k]) => k);
            if (top.length > 1) tie = true;
            else if (top[0] === "skip") skipped = true;
            else executedId = top[0];
        }

        if (executedId) game.killPlayer(executedId, "vote");

        return { executedId, tally, tie, skipped, winner: game.checkWinCondition() };
    }
}
