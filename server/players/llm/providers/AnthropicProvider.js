import { Provider } from "./Provider.js";

/**
 * Anthropic (Claude) provider skeleton. No network calls are made yet.
 *
 * The API key is read from ANTHROPIC_API_KEY by server/config.js, lives only in
 * server memory, and is never included in any view, event or error sent to a
 * client.
 *
 * TODO(enable):
 *   1. Add the official SDK (`npm install --save-exact @anthropic-ai/sdk`). It
 *      is not in this project's approved dependency list yet, so this needs
 *      the maintainer's OK.
 *   2. Implement send() with client.messages.create({...this.buildRequest(...)})
 *      and map response.usage.{input_tokens, output_tokens} into
 *      { inputTokens, outputTokens }. Check stop_reason ("refusal",
 *      "max_tokens") before reading content.
 *   3. For chooseAction, use structured outputs (output_config.format with a
 *      JSON schema for { targetId }) instead of free-form JSON.
 */
export class AnthropicProvider extends Provider {
    constructor({ apiKey, model = "claude-opus-5-5", enabled = false } = {}) {
        super();
        if (!enabled) throw new Error("LLM players are disabled (set ENABLE_LLM_PLAYERS=true)");
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
        // Non-enumerable so it can't end up in JSON.stringify / logs by accident.
        Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false });
        this.model = model;
    }

    buildRequest({ system, user, maxTokens }, { json = false } = {}) {
        return {
            model: this.model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: user }],
            // Game turns are short and latency-sensitive.
            output_config: {
                effort: "low",
                ...(json
                    ? {
                        format: {
                            type: "json_schema",
                            schema: {
                                type: "object",
                                properties: { targetId: { type: ["string", "null"] } },
                                required: ["targetId"],
                                additionalProperties: false,
                            },
                        },
                    }
                    : {}),
            },
        };
    }

    async send(_request) {
        // TODO(enable): call the Messages API here (see the class comment).
        throw new Error("AnthropicProvider.send is not implemented yet");
    }

    async generateMessage(prompt) {
        return this.send(this.buildRequest(prompt));
    }

    async chooseAction(prompt) {
        return this.send(this.buildRequest(prompt, { json: true }));
    }

    toJSON() {
        return { provider: "anthropic", model: this.model };
    }
}

export function createProvider(llmConfig) {
    if (!llmConfig.enabled) return null;
    return new AnthropicProvider({ apiKey: llmConfig.apiKey, model: llmConfig.model, enabled: true });
}
