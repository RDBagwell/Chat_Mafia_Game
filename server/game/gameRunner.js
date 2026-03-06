import { nightPhase, dayPhase } from "./phase.js";
import { activePlayers } from "./engine.js";


/*
  Runs full simulation until win condition is met.
  Uses your existing phase logic.
*/

export function runGame(game) {
    const MAX_ROUNDS = 100;

    // Ensure defaults
    game.events = game.events ?? [];
    game.round = game.round ?? 1;
    game.phase = game.phase ?? "night";
    game.gameState = game.gameState ?? "running";

    while (game.gameState !== "ended" && game.round <= MAX_ROUNDS) {

        if (game.phase === "night") {
            nightPhase(game);

            if (game.gameState === "ended") break;
        }

        if (game.phase === "day") {
            dayPhase(game);
            // Only increment round AFTER a full day cycle
            if (game.gameState === "ended") break;

            game.round++;
        }
    }

    // Find the FIRST event that has a winCondition
    const winEvent = game.events.find(e => e.winCondition);

    if (game.round > MAX_ROUNDS) {
        throw new Error("Game exceeded maximum safe rounds");
    }

    return {
        winner: winEvent?.winCondition?.winner ?? null,
        reason: winEvent?.winCondition?.reason ?? null,
        roundsPlayed: game.round,
        events: game.events
    };
}

/**
 * Run the full game until a win condition is met
 * Returns a summary object
 */
export function runFullGame(game) {
    const result = {
        winner: null,
        reason: null,
        roundsPlayed: 0,
        finalActivePlayers: [],
        events: []
    };

    // Keep looping until game ends
    while (game.gameState !== "ended") {
        // Execute the current phase
        if (game.phase === "night") {
            nightPhase(game);
        } else if (game.phase === "day") {
            dayPhase(game);
        }

        // Append all new events since last check
        result.events.push(...game.events.slice(result.events.length));

        // Update rounds played
        result.roundsPlayed = game.round;

        // Update winner if a win condition occurred
        const lastEvent = result.events[result.events.length - 1];
        if (lastEvent?.winCondition) {
            result.winner = lastEvent.winCondition.winner;
            result.reason = lastEvent.winCondition.reason;
        }
    }

    // Capture final active players
    result.finalActivePlayers = activePlayers(game.players);

    return result;
}