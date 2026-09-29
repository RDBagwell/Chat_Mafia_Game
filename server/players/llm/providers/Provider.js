/**
 * LLM provider interface. Implementations must never be handed anything but
 * the prompt built by server/players/llm/prompt.js.
 *
 * generateMessage({ system, user, maxTokens }) -> Promise<{ text, usage }>
 * chooseAction({ system, user, maxTokens })    -> Promise<{ text, usage }>
 *   usage: { inputTokens, outputTokens }
 */
export class Provider {
    async generateMessage(_prompt) {
        throw new Error("not implemented");
    }

    async chooseAction(_prompt) {
        throw new Error("not implemented");
    }
}
