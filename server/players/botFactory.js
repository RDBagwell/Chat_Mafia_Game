import { RandomBot } from "./RandomBot.js";

/**
 * Builds the controller for a new bot seat. LLM players are not offered here
 * yet: see server/players/llm/ (disabled unless ENABLE_LLM_PLAYERS=true).
 */
export function defaultBotFactory(session, config) {
    return new RandomBot({ scheduler: session.scheduler, ...config.bots });
}
