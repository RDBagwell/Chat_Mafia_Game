import crypto from "node:crypto";
import { RandomBot } from "./RandomBot.js";
import { LLMPlayer } from "./llm/LLMPlayer.js";
import { TokenBudget } from "./llm/budget.js";

/** A random legal choice for the seat's current action (used when the model can't decide). */
export function randomLegalChoice(view) {
    const action = view.you.action;
    if (!action) return undefined;
    if (action.allowSkip && (!action.targets.length || crypto.randomInt(5) === 0)) return null;
    if (!action.targets.length) return undefined;
    return action.targets[crypto.randomInt(action.targets.length)];
}

/**
 * Builds controllers for bot seats: (session, kind) => controller | null.
 * kind "random" is a RandomBot; kind "llm" is an AI player, available only
 * when an LLM provider is configured (ENABLE_LLM_PLAYERS=true + API key).
 * All AI seats in one game share that game's token budget.
 */
export function createBotFactory({ config, llmProvider = null, log = () => {} }) {
    const factory = (session, kind = "random") => {
        if (kind === "llm") {
            if (!llmProvider) return null;
            session.llmBudget ??= new TokenBudget(config.llm.tokenBudgetPerGame);
            return new LLMPlayer({
                provider: llmProvider,
                budget: session.llmBudget,
                scheduler: session.scheduler,
                llmConfig: config.llm,
                fallback: randomLegalChoice,
                log,
            });
        }
        return new RandomBot({ scheduler: session.scheduler, ...config.bots });
    };
    factory.features = { aiPlayers: Boolean(llmProvider) };
    return factory;
}
