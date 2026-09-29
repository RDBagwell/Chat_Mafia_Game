import { GameSession, realScheduler } from "./GameSession.js";
import { generateGameCode } from "../security/random.js";

/** Registry of running games, with caps and idle cleanup. */
export class GameManager {
    constructor(config, { scheduler = realScheduler, transport = null, botFactory = null, log = () => {} } = {}) {
        this.config = config;
        this.scheduler = scheduler;
        this.transport = transport;
        this.botFactory = botFactory;
        this.log = log;
        this.games = new Map();
        this.sweeper = null;
    }

    create() {
        if (this.games.size >= this.config.maxGames) return null;
        let code;
        do code = generateGameCode();
        while (this.games.has(code));
        const session = new GameSession(code, {
            config: this.config,
            scheduler: this.scheduler,
            transport: this.transport,
            botFactory: this.botFactory,
            log: this.log,
        });
        this.games.set(code, session);
        return session;
    }

    get(code) {
        return this.games.get(code) ?? null;
    }

    remove(code, reason = "closed") {
        const session = this.games.get(code);
        if (!session) return;
        this.games.delete(code);
        session.destroy(reason);
    }

    /** Removes games that are idle, or that have had no connected human for a while. */
    sweep(now = this.scheduler.now()) {
        for (const [code, session] of this.games) {
            if (session.hasConnectedHumans()) session.emptySince = null;
            else session.emptySince ??= now;

            const idle = now - session.lastActivityAt > this.config.idleGameMs;
            const empty = session.emptySince !== null && now - session.emptySince > this.config.emptyGameMs;
            if (idle || empty) {
                this.log("info", `removing game (${idle ? "idle" : "empty"})`);
                this.remove(code, "closed");
            }
        }
    }

    startSweeper() {
        this.sweeper = setInterval(() => {
            try {
                this.sweep();
            } catch (err) {
                this.log("error", `sweep failed: ${err?.message}`);
            }
        }, this.config.sweepIntervalMs);
        this.sweeper.unref?.();
    }

    stop() {
        clearInterval(this.sweeper);
        for (const code of [...this.games.keys()]) this.remove(code, "closed");
    }
}
