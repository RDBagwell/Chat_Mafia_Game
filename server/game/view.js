import { PHASES, ROLES, teamOf } from "./constants.js";
import { readableChannels, writableChannels } from "./channels.js";

/**
 * getViewFor is the ONLY way game state leaves the server. Socket payloads,
 * reconnect snapshots and bot/LLM controllers all receive its output, so the
 * rules below are the complete list of what any viewer can learn.
 */

const MAX_EVENTS_IN_VIEW = 100;

/** May `viewer` see `target`'s role? */
export function canSeeRole(game, viewer, target) {
    if (!viewer || !target) return false;
    if (viewer.id === target.id) return true;
    if (game.phase === PHASES.ENDED) return true;
    if (target.revealed) return true;
    if (!viewer.alive && !viewer.kicked) return true; // observers see everything
    return viewer.role === ROLES.MAFIA && target.role === ROLES.MAFIA;
}

export function canSeeEvent(game, viewer, event) {
    const v = event.visibility || {};
    if (v.public) return true;
    if (!viewer) return false;
    if (v.dead && !viewer.alive && !viewer.kicked) return true;
    if (v.mafia && viewer.role === ROLES.MAFIA) return true;
    return Array.isArray(v.players) && v.players.includes(viewer.id);
}

/** Observers (the dead) see night actions as they happen. */
function isObserver(viewer) {
    return !viewer.alive && !viewer.kicked;
}

/**
 * The action `player` may take right now, with the exact set of legal targets.
 * GameSession validates every submitted action against this same function.
 */
export function availableAction(game, player) {
    if (!player || !player.alive || player.kicked) return null;
    const others = game.activePlayers().filter((p) => p.id !== player.id);

    if (game.phase === PHASES.NIGHT) {
        switch (player.role) {
            case ROLES.MAFIA:
                return {
                    type: "kill",
                    targets: game.mafiaTargets().map((p) => p.id),
                    current: game.night.mafiaVotes.get(player.id) ?? null,
                };
            case ROLES.DOCTOR:
                return {
                    type: "protect",
                    targets: game
                        .activePlayers()
                        .filter((p) => p.id !== game.lastProtectedId)
                        .map((p) => p.id),
                    current: game.night.doctorTarget?.targetId ?? null,
                };
            case ROLES.DETECTIVE:
                return {
                    type: "investigate",
                    targets: others.map((p) => p.id),
                    current: game.night.detectiveTarget?.targetId ?? null,
                };
            default:
                return null;
        }
    }

    if (game.phase === PHASES.VOTE) {
        return {
            type: "vote",
            targets: others.map((p) => p.id),
            allowSkip: true,
            hasVoted: game.votes.has(player.id),
            current: game.votes.get(player.id) ?? null,
        };
    }
    return null;
}

function publicPlayer(game, viewer, p) {
    return {
        id: p.id,
        name: p.name,
        alive: p.alive,
        isBot: p.isBot,
        isHost: p.id === game.hostId,
        connected: p.isBot ? true : Boolean(p.connected),
        kicked: p.kicked,
        role: canSeeRole(game, viewer, p) ? p.role : null,
    };
}

/**
 * @param {Game} game
 * @param {string} playerId
 * @param {{ now?: number, includeChat?: boolean }} [options]
 */
export function getViewFor(game, playerId, { now = Date.now(), includeChat = false } = {}) {
    const viewer = game.getPlayer(playerId);
    if (!viewer || viewer.kicked) return null;

    const observer = isObserver(viewer);
    const readable = readableChannels(game, viewer);

    const view = {
        gameId: game.id,
        phase: game.phase,
        round: game.round,
        serverNow: now,
        phaseEndsAt: game.phaseEndsAt,
        settings: { ...game.settings },
        roleCounts: game.roleCounts ? { ...game.roleCounts } : null,
        minPlayers: game.minPlayers(),
        maxPlayers: game.maxPlayers,
        hostId: game.hostId,
        winner: game.phase === PHASES.ENDED ? game.winner : null,
        you: {
            id: viewer.id,
            name: viewer.name,
            role: viewer.role,
            team: viewer.role ? teamOf(viewer.role) : null,
            alive: viewer.alive,
            isHost: viewer.id === game.hostId,
            observer,
            readableChannels: readable,
            writableChannels: writableChannels(game, viewer),
            action: availableAction(game, viewer),
            investigations: viewer.role === ROLES.DETECTIVE ? viewer.investigations.map((i) => ({ ...i })) : [],
            lastProtectedId: viewer.role === ROLES.DOCTOR ? game.lastProtectedId : null,
        },
        players: game.players.map((p) => publicPlayer(game, viewer, p)),
        // Day votes are public as they happen.
        dayVotes: game.phase === PHASES.VOTE ? Object.fromEntries(game.votes) : null,
        mafiaVotes: null,
        nightActions: null,
        events: game.events.filter((e) => canSeeEvent(game, viewer, e)).slice(-MAX_EVENTS_IN_VIEW),
    };

    if (game.phase === PHASES.NIGHT && (viewer.role === ROLES.MAFIA || observer)) {
        view.mafiaVotes = Object.fromEntries(game.night.mafiaVotes);
    }
    if (game.phase === PHASES.NIGHT && observer) {
        view.nightActions = {
            protect: game.night.doctorTarget ? { ...game.night.doctorTarget } : null,
            investigate: game.night.detectiveTarget ? { ...game.night.detectiveTarget } : null,
        };
    }
    if (includeChat) {
        view.chat = Object.fromEntries(readable.map((c) => [c, game.chat[c].map((m) => ({ ...m }))]));
    }
    return view;
}
