import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { Provider } from "./Provider.js";

// Server-side refusal fallback: if a safety classifier declines a request, the
// API re-runs it on Anthropic's recommended fallback model inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Models that accept `fallbacks: "default"`. Others (e.g. claude-haiku-5-5)
// have no server-side fallback, so the parameter is left off for them.
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** The only shape an action reply may take. The server re-validates the target anyway. */
const ActionChoice = z.object({ targetId: z.string().nullable() });

/**
 * Typed failure from the provider. `kind` is one of:
 *   refusal | truncated | rate_limited | auth | bad_request | unavailable
 * LLMPlayer treats every failure the same way (fall back to a random legal
 * move or stay silent); `kind` is for logs.
 */
export class LLMProviderError extends Error {
    constructor(kind, message, usage = null) {
        super(message);
        this.name = "LLMProviderError";
        this.kind = kind;
        this.usage = usage;
    }
}

function mapUsage(usage) {
    return { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 };
}

/** Maps SDK errors (most specific first) to LLMProviderError. */
function mapError(err) {
    if (err instanceof LLMProviderError) return err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return new LLMProviderError("auth", "Anthropic API rejected the API key");
    }
    if (err instanceof Anthropic.RateLimitError) return new LLMProviderError("rate_limited", "Anthropic API rate limit");
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        return new LLMProviderError("bad_request", `Anthropic API rejected the request (${err.status})`);
    }
    if (err instanceof Anthropic.APIConnectionError) return new LLMProviderError("unavailable", "Could not reach the Anthropic API");
    if (err instanceof Anthropic.APIError) return new LLMProviderError("unavailable", `Anthropic API error (${err.status})`);
    return new LLMProviderError("unavailable", "Unexpected provider error");
}

/**
 * Claude provider for LLM players.
 *
 * Only the prompt built by server/players/llm/prompt.js (the player's own
 * view + readable chat) is ever sent. The API key is read from
 * ANTHROPIC_API_KEY by server/config.js and lives only inside the SDK client,
 * which is stored non-enumerably so it can't end up in JSON or logs.
 */
export class AnthropicProvider extends Provider {
    constructor({ apiKey, model = "claude-opus-5-5", enabled = false, client = null, timeoutMs = 20000, maxRetries = 1 } = {}) {
        super();
        if (!enabled) throw new Error("LLM players are disabled (set ENABLE_LLM_PLAYERS=true)");
        if (!client && !apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
        Object.defineProperty(this, "client", {
            value: client ?? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries }),
            enumerable: false,
        });
        this.model = model;
        this.disabled = false; // set after an auth failure so we stop calling with a bad key
    }

    buildRequest({ system, user, maxTokens }) {
        return {
            model: this.model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: user }],
            // Game turns are short and latency-sensitive; thinking stays on (it
            // can't be disabled on this model) but at low effort.
            output_config: { effort: "low" },
            ...(SERVER_FALLBACK_MODELS.has(this.model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
        };
    }

    async run(fn) {
        if (this.disabled) throw new LLMProviderError("auth", "Provider disabled after an authentication failure");
        try {
            return await fn();
        } catch (err) {
            const mapped = mapError(err);
            if (mapped.kind === "auth") this.disabled = true;
            throw mapped;
        }
    }

    /** Returns { text, usage } with text = JSON {"targetId": ...}. */
    async chooseAction(prompt) {
        const request = this.buildRequest(prompt);
        request.output_config = { ...request.output_config, format: zodOutputFormat(ActionChoice) };
        const res = await this.run(() => this.client.beta.messages.parse(request));
        const usage = mapUsage(res.usage);
        if (res.stop_reason === "refusal") throw new LLMProviderError("refusal", "Model declined to choose an action", usage);
        if (res.stop_reason === "max_tokens" || !res.parsed_output) {
            throw new LLMProviderError("truncated", "No complete action in the reply", usage);
        }
        return { text: JSON.stringify(res.parsed_output), usage };
    }

    /** Returns { text, usage } with the chat line as plain text. */
    async generateMessage(prompt) {
        const res = await this.run(() => this.client.beta.messages.create(this.buildRequest(prompt)));
        const usage = mapUsage(res.usage);
        if (res.stop_reason === "refusal") throw new LLMProviderError("refusal", "Model declined to write a message", usage);
        const text = res.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(" ")
            .trim();
        // A max_tokens stop with some text is usable (LLMPlayer truncates anyway);
        // with no text at all, the budget went on thinking.
        if (!text) throw new LLMProviderError("truncated", "No text in the reply", usage);
        return { text, usage };
    }

    toJSON() {
        return { provider: "anthropic", model: this.model };
    }
}

/** Returns a provider, or null when LLM players are off or misconfigured. */
export function createProvider(llmConfig, log = () => {}) {
    if (!llmConfig.enabled) return null;
    if (!llmConfig.apiKey) {
        log("error", "ENABLE_LLM_PLAYERS=true but ANTHROPIC_API_KEY is not set; AI players stay disabled");
        return null;
    }
    log("info", `AI players enabled (model ${llmConfig.model})`);
    return new AnthropicProvider({ apiKey: llmConfig.apiKey, model: llmConfig.model, enabled: true });
}
