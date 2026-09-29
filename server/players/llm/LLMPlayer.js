import { PlayerController } from "../PlayerController.js";
import { buildPrompt, cleanMessage, parseActionReply } from "./prompt.js";

const ACTION_MAX_TOKENS = 200;
const MESSAGE_MAX_TOKENS = 300;
const TRANSCRIPT_CAP = 100;

/**
 * A seat played by a language model (stub). The engine treats it like any
 * other controller:
 *   - input: onState(getViewFor view) and onChat(messages it may read) — nothing else
 *   - output: this.act(...) → session.handleCommand, the same validation as humans
 *
 * Caps: message length (config.llm.maxMessageChars), message rate
 * (minMsBetweenMessages), and a per-game TokenBudget shared by all LLM seats.
 * When the budget runs out or the provider fails, it falls back to a random
 * legal move so the game never stalls.
 */
export class LLMPlayer extends PlayerController {
    constructor({ provider, budget, scheduler, llmConfig, fallback }) {
        super();
        this.provider = provider;
        this.budget = budget;
        this.scheduler = scheduler;
        this.llm = llmConfig;
        this.fallback = fallback; // a RandomBot-like chooser: (view) => targetId | null
        this.view = null;
        this.transcript = [];
        this.actedFor = null;
        this.lastMessageAt = -Infinity;
        this.busy = false;
    }

    onChat(message) {
        this.transcript.push(message);
        if (this.transcript.length > TRANSCRIPT_CAP) this.transcript.shift();
    }

    onState(view) {
        this.view = view;
        if (view.chat) {
            // History for channels this seat can read (e.g. after dying).
            this.transcript = Object.values(view.chat).flat().sort((a, b) => a.id - b.id).slice(-TRANSCRIPT_CAP);
        }
        const key = `${view.phase}:${view.round}`;
        if (view.you.action && this.actedFor !== key) {
            this.actedFor = key;
            this.decide(key).catch(() => {});
        }
    }

    async call(kind, prompt, maxTokens) {
        if (!this.budget.canSpend(maxTokens * 4)) return null;
        try {
            const res = await this.provider[kind]({ ...prompt, maxTokens });
            this.budget.record(res?.usage);
            return res?.text ?? null;
        } catch {
            return null;
        }
    }

    async decide(key) {
        const view = this.view;
        const text = await this.call("chooseAction", buildPrompt(view, this.transcript, "action"), ACTION_MAX_TOKENS);
        if (!this.session || `${this.view.phase}:${this.view.round}` !== key) return;
        let targetId = text === null ? undefined : parseActionReply(text, this.view);
        if (targetId === undefined) targetId = this.fallback?.(this.view);
        if (targetId === undefined) return;
        const type = this.view.you.action?.type === "vote" ? "vote" : "nightAction";
        this.act(type, { targetId });
    }

    /** Posts one chat message if rate and budget allow. TODO(prompt design): decide when to speak. */
    async speak(channel = "general") {
        const now = this.scheduler.now();
        if (this.busy || now - this.lastMessageAt < this.llm.minMsBetweenMessages) return false;
        if (!this.view?.you.writableChannels.includes(channel)) return false;
        this.busy = true;
        try {
            const text = await this.call("generateMessage", buildPrompt(this.view, this.transcript, "message"), MESSAGE_MAX_TOKENS);
            const clean = cleanMessage(text, this.llm.maxMessageChars);
            if (!clean) return false;
            this.lastMessageAt = this.scheduler.now();
            return this.act("chat", { channel, text: clean }).ok;
        } finally {
            this.busy = false;
        }
    }
}
