import { ROLES } from "./constants.js";
import { secureChoice } from "../security/random.js";

/**
 * Resolves the night from the actions players submitted (game.night).
 * Actions whose actor is no longer alive (or no longer holds the role) are
 * ignored, and a missing action simply means no action.
 */
export class NightResolver {
    /** Plurality of living Mafia votes; ties broken uniformly at random. */
    tallyMafiaVotes(game) {
        const counts = new Map();
        for (const [voterId, targetId] of game.night.mafiaVotes) {
            const voter = game.getPlayer(voterId);
            const target = game.getPlayer(targetId);
            if (!voter?.alive || voter.role !== ROLES.MAFIA) continue;
            if (!target?.alive || target.role === ROLES.MAFIA) continue;
            counts.set(targetId, (counts.get(targetId) || 0) + 1);
        }
        if (!counts.size) return null;
        const max = Math.max(...counts.values());
        const top = [...counts].filter(([, c]) => c === max).map(([id]) => id);
        return secureChoice(top);
    }

    validAction(game, action, role) {
        if (!action) return null;
        const actor = game.getPlayer(action.actorId);
        const target = game.getPlayer(action.targetId);
        if (!actor?.alive || actor.role !== role) return null;
        if (!target?.alive) return null;
        return target.id;
    }

    resolve(game) {
        const targetedId = this.tallyMafiaVotes(game);
        const protectedId = this.validAction(game, game.night.doctorTarget, ROLES.DOCTOR);
        const investigatedId = this.validAction(game, game.night.detectiveTarget, ROLES.DETECTIVE);

        // Investigate before the kill lands: the Detective acted during the night.
        let investigation = null;
        if (investigatedId) {
            const target = game.getPlayer(investigatedId);
            const detective = game.getPlayer(game.night.detectiveTarget.actorId);
            investigation = {
                detectiveId: detective.id,
                targetId: target.id,
                result: target.role === ROLES.MAFIA ? "Mafia" : "Not Mafia",
            };
            detective.investigations.push({
                round: game.round,
                targetId: target.id,
                targetName: target.name,
                result: investigation.result,
            });
        }

        const saved = Boolean(targetedId && targetedId === protectedId);
        let killedId = null;
        if (targetedId && !saved) {
            game.killPlayer(targetedId, "mafia");
            killedId = targetedId;
        }

        // The Doctor may not protect the same player two nights running.
        game.lastProtectedId = protectedId;

        return {
            targetedId,
            protectedId,
            saved,
            killedId,
            investigation,
            winner: game.checkWinCondition(),
        };
    }
}
