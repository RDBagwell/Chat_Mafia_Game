import { emit } from "./socket.js";

/**
 * Creates a new game session.
 */
export function createGame() {
    console.log("Creating game...");
    safeEmit("createGame");
}

/**
 * Joins an existing game.
 * @param {string} userName
 * @param {string} gameId
 */
export function joinGame(userName, gameId) {
    if (!userName || !gameId) throw new Error("userName and gameId are required");
    safeEmit("joinGame", { userName, gameId });
}

/**
 * Starts the game for the specified game ID.
 * @param {string} gameId
 *
 */
export function startGame(gameId) {
    if (!gameId) throw new Error("gameId is required");
    console.log(`-- Starting game ${gameId} --`);
    safeEmit("startGame", { gameId });
}

/**
 * Sends a chat message in the current game.
 * @param {string} gameId
 * @param {string} userName
 * @param {string} message
 */
export function sendChat(gameId, userName, message) {
    if (!gameId) throw new Error("gameId is required");
    if (!userName) throw new Error("userName is required");
    if (!message) throw new Error("message is required");
    console.log(`-- Sending chat message: ${message} --`);
    safeEmit("chatMessage", { gameId, userName, message });
}

/**
 * Emits an event safely, with basic error handling.
 * @param {string} event
 * @param {object} [payload]
 */
function safeEmit(event, payload = {}) {
    try {
        emit(event, payload);
    } catch (error) {
        console.error(`[socket] Failed to emit "${event}":`, error);
    }
}