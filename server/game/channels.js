import { PHASES, ROLES } from "./constants.js";

/**
 * Chat channel permissions. This is the only place that decides who may read
 * or write a channel; the socket layer, the view builder and bots all ask here.
 *
 * | Channel | Write                                          | Read               |
 * |---------|------------------------------------------------|--------------------|
 * | general | living players in lobby/discussion/vote;       | everyone           |
 * |         | everyone once the game is over                 |                    |
 * | mafia   | living Mafia during the game                   | living Mafia, dead |
 * | dead    | dead players                                   | dead players       |
 * | system  | server only                                    | everyone           |
 */
export const CHANNELS = Object.freeze(["general", "mafia", "dead", "system"]);

const GENERAL_WRITE_PHASES = new Set([PHASES.LOBBY, PHASES.DISCUSSION, PHASES.VOTE]);
const IN_GAME = new Set([PHASES.NIGHT, PHASES.MORNING, PHASES.DISCUSSION, PHASES.VOTE, PHASES.ENDED]);

function isMember(player) {
    return Boolean(player) && !player.kicked;
}

export function canRead(game, player, channel) {
    if (!isMember(player)) return false;
    switch (channel) {
        case "system":
        case "general":
            return true;
        case "mafia":
            return IN_GAME.has(game.phase) && (!player.alive || player.role === ROLES.MAFIA);
        case "dead":
            return IN_GAME.has(game.phase) && !player.alive;
        default:
            return false;
    }
}

export function canWrite(game, player, channel) {
    if (!isMember(player)) return false;
    switch (channel) {
        case "general":
            if (game.phase === PHASES.ENDED) return true;
            return player.alive && GENERAL_WRITE_PHASES.has(game.phase);
        case "mafia":
            return (
                player.alive &&
                player.role === ROLES.MAFIA &&
                IN_GAME.has(game.phase) &&
                game.phase !== PHASES.ENDED
            );
        case "dead":
            return !player.alive && IN_GAME.has(game.phase);
        default:
            return false; // "system" and anything unknown
    }
}

export function readableChannels(game, player) {
    return CHANNELS.filter((c) => canRead(game, player, c));
}

export function writableChannels(game, player) {
    return CHANNELS.filter((c) => canWrite(game, player, c));
}

export function roomName(gameId, channel) {
    return `game:${gameId}:${channel}`;
}
