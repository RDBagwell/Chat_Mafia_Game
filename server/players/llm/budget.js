/**
 * Per-game token budget shared by every LLM seat in that game. Once spent, LLM
 * players stop calling the provider and fall back to random legal moves.
 */
export class TokenBudget {
    constructor(total) {
        this.total = total;
        this.used = 0;
    }

    get remaining() {
        return Math.max(0, this.total - this.used);
    }

    canSpend(estimate) {
        return this.remaining >= estimate;
    }

    record(usage) {
        this.used += (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    }
}
