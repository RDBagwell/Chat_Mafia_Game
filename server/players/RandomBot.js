import crypto from "node:crypto";
import { PlayerController } from "./PlayerController.js";

const LINES = [
    "I have a bad feeling about this.",
    "Who was quiet last night? Just asking.",
    "I'm a simple villager, I swear.",
    "Something about that last vote felt off.",
    "Let's not rush this.",
    "I trust nobody. Especially not me.",
    "Anyone want to claim a role? No? Okay.",
];

const rand = (n) => crypto.randomInt(n);

/**
 * Makes random legal moves. It only ever sees its own getViewFor() snapshot,
 * and it acts through session.handleCommand like any human, so every rule
 * and validation applies. Useful for filling seats and for solo testing.
 */
export class RandomBot extends PlayerController {
    constructor({ scheduler, minDelayMs = 1500, maxDelayMs = 5000, chatChance = 0.25 } = {}) {
        super();
        this.scheduler = scheduler;
        this.minDelayMs = minDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.chatChance = chatChance;
        this.view = null;
        this.plannedFor = null;
        this.chattedIn = null;
        this.timers = new Set();
    }

    later(fn) {
        const span = Math.max(0, this.maxDelayMs - this.minDelayMs);
        const delay = this.minDelayMs + (span ? rand(span + 1) : 0);
        const timer = this.scheduler.setTimeout(() => {
            this.timers.delete(timer);
            if (this.session) fn();
        }, delay);
        this.timers.add(timer);
    }

    phaseKey(view) {
        return `${view.phase}:${view.round}`;
    }

    onState(view) {
        this.view = view;
        if (view.phase === "lobby") {
            // A new game in the same lobby restarts round numbers; forget the old ones.
            this.plannedFor = null;
            this.chattedIn = null;
            return;
        }
        const key = this.phaseKey(view);
        const action = view.you.action;

        if (action && this.plannedFor !== key) {
            this.plannedFor = key;
            this.later(() => this.takeAction(key));
        }

        if (view.phase === "discussion" && view.you.alive && this.chattedIn !== key) {
            this.chattedIn = key;
            if (Math.random() < this.chatChance) {
                this.later(() => this.act("chat", { channel: "general", text: LINES[rand(LINES.length)] }));
            }
        }
    }

    takeAction(key) {
        const view = this.view;
        if (!view || this.phaseKey(view) !== key) return;
        const action = view.you.action;
        if (!action || !action.targets.length) {
            if (action?.allowSkip) this.act("vote", { targetId: null });
            return;
        }
        if (action.type === "vote") {
            const skip = action.allowSkip && rand(5) === 0;
            this.act("vote", { targetId: skip ? null : action.targets[rand(action.targets.length)] });
        } else {
            this.act("nightAction", { targetId: action.targets[rand(action.targets.length)] });
        }
    }

    detach(reason) {
        for (const t of this.timers) this.scheduler?.clearTimeout(t);
        this.timers.clear();
        super.detach(reason);
    }
}
