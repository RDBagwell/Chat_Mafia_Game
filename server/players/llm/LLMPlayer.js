import crypto from "node:crypto";
import { PlayerController } from "../PlayerController.js";
import { buildPrompt, cleanMessage, parseActionReply } from "./prompt.js";

// Thinking is always on for the default model and counts toward max_tokens,
// so these leave room for a short think plus a short answer.
const ACTION_MAX_TOKENS = 1500;
const MESSAGE_MAX_TOKENS = 1500;
const TRANSCRIPT_CAP = 100;

/**
 * A seat played by a language model. The engine treats it like any other
 * controller:
 *   - input: onState(getViewFor view) and onChat(messages it may read) — nothing else
 *   - output: this.act(...) → session.handleCommand, the same validation as humans
 *
 * Caps: message length (llm.maxMessageChars), message rate
 * (llm.minMsBetweenMessages), messages per discussion (llm.messagesPerDiscussion),
 * and a per-game TokenBudget shared by all LLM seats. When the budget runs out
 * or the provider fails, it falls back to a random legal move (and stays quiet)
 * so the game never stalls.
 */
export class LLMPlayer extends PlayerController {
    constructor({ provider, budget, scheduler, llmConfig, fallback, log = () => {} }) {
        super();
        this.provider = provider;
        this.budget = budget;
        this.scheduler = scheduler;
        this.llm = llmConfig;
        this.fallback = fallback; // (view) => legal targetId | null | undefined
        this.log = log;
        this.view = null;
        this.transcript = [];
        this.actedFor = null;
        this.speechPlannedFor = null;
        this.lastMessageAt = -Infinity;
        this.busy = false;
        this.timers = new Set();
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
        if (view.phase === "lobby") {
            // A new game in the same lobby restarts round numbers; forget the old ones.
            this.actedFor = null;
            this.speechPlannedFor = null;
            return;
        }
        const key = this.phaseKey(view);
        if (view.you.action && this.actedFor !== key) {
            this.actedFor = key;
            this.decide(key).catch(() => {});
        }
        if (view.phase === "discussion" && view.you.alive && this.speechPlannedFor !== key) {
            this.speechPlannedFor = key;
            for (let i = 0; i < this.llm.messagesPerDiscussion; i++) this.later(() => this.speak("general", key));
        }
    }

    phaseKey(view) {
        return `${view.phase}:${view.round}`;
    }

    later(fn) {
        const [min, max] = this.llm.speakDelayMs;
        const timer = this.scheduler.setTimeout(() => {
            this.timers.delete(timer);
            if (this.session) fn();
        }, min + crypto.randomInt(Math.max(1, max - min + 1)));
        this.timers.add(timer);
    }

    /** One provider call, within budget. Returns the reply text or null. */
    async call(kind, prompt, maxTokens) {
        const estimate = Math.ceil((prompt.system.length + prompt.user.length) / 4) + maxTokens;
        if (!this.budget.canSpend(estimate)) return null;
        try {
            const res = await this.provider[kind]({ ...prompt, maxTokens });
            this.budget.record(res?.usage);
            return res?.text ?? null;
        } catch (err) {
            this.budget.record(err?.usage);
            // Log the failure kind only: never prompts, replies or keys.
            this.log("warn", `LLM ${kind} failed: ${err?.kind ?? "error"}`);
            return null;
        }
    }

    async decide(key) {
        const view = this.view;
        const text = await this.call("chooseAction", buildPrompt(view, this.transcript, "action"), ACTION_MAX_TOKENS);
        if (!this.session || this.phaseKey(this.view) !== key || !this.view.you.action) return;
        let targetId = text === null ? undefined : parseActionReply(text, this.view);
        if (targetId === undefined) targetId = this.fallback?.(this.view);
        if (targetId === undefined) return;
        const type = this.view.you.action.type === "vote" ? "vote" : "nightAction";
        this.act(type, { targetId });
    }

    /** Posts one chat message if the phase, rate and budget allow. */
    async speak(channel = "general", key = null) {
        const now = this.scheduler.now();
        if (this.busy || now - this.lastMessageAt < this.llm.minMsBetweenMessages) return false;
        if (key && this.phaseKey(this.view) !== key) return false;
        if (!this.view?.you.writableChannels.includes(channel)) return false;
        this.busy = true;
        try {
            const text = await this.call("generateMessage", buildPrompt(this.view, this.transcript, "message"), MESSAGE_MAX_TOKENS);
            const clean = cleanMessage(text, this.llm.maxMessageChars);
            if (!clean || !this.session || (key && this.phaseKey(this.view) !== key)) return false;
            this.lastMessageAt = this.scheduler.now();
            return this.act("chat", { channel, text: clean }).ok;
        } finally {
            this.busy = false;
        }
    }

    detach(reason) {
        for (const t of this.timers) this.scheduler?.clearTimeout(t);
        this.timers.clear();
        super.detach(reason);
    }
}
