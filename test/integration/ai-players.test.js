import { describe, it, expect, afterEach } from "vitest";
import { startServer, waitFor } from "../helpers.js";
import { loadConfig } from "../../server/config.js";

let env;
afterEach(async () => env?.close());

const fastLlm = { ...loadConfig({}).llm, speakDelayMs: [0, 5], minMsBetweenMessages: 0, messagesPerDiscussion: 2 };

/** Picks the first legal target named in the prompt; chats a fixed line. Never touches the network. */
function cooperativeProvider() {
    const prompts = [];
    return {
        prompts,
        async chooseAction(prompt) {
            prompts.push(prompt);
            const state = JSON.parse(prompt.user.match(/<game_state>\n([\s\S]*?)\n<\/game_state>/)[1]);
            const targetId = state.action?.targets[0]?.id ?? null;
            return { text: JSON.stringify({ targetId }), usage: { inputTokens: 100, outputTokens: 10 } };
        },
        async generateMessage(prompt) {
            prompts.push(prompt);
            return { text: "I have my eye on someone.", usage: { inputTokens: 100, outputTokens: 10 } };
        },
    };
}

/** Tries to cheat: illegal targets, oversized and markup-laden chat. */
function hostileProvider() {
    return {
        async chooseAction() {
            return { text: JSON.stringify({ targetId: "p_ffffffffffffffff" }), usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async generateMessage() {
            return { text: "<script>alert(1)</script> " + "x".repeat(2000), usage: { inputTokens: 1, outputTokens: 1 } };
        },
    };
}

async function playWithAi(llmProvider, aiCount = 5) {
    env = await startServer({ llmProvider, config: { llm: fastLlm } });
    const host = env.connect();
    await host.connected;
    await host.request("createGame", { name: "Alice" });
    await host.waitForState((s) => s.features.aiPlayers === true);
    for (let i = 0; i < aiCount; i++) expect(await host.request("addBot", { kind: "llm" })).toEqual({ ok: true });
    await host.waitForState((s) => s.players.length === aiCount + 1);
    expect(host.state.players.filter((p) => p.isAI)).toHaveLength(aiCount);
    expect(await host.request("startGame", {})).toEqual({ ok: true });

    const seen = new Set();
    await waitFor(() => {
        const s = host.state;
        if (s.phase === "ended") return true;
        const key = `${s.phase}:${s.round}:${JSON.stringify(s.you.action?.current ?? "")}:${s.you.action?.hasVoted}`;
        if (!seen.has(key)) {
            seen.add(key);
            const action = s.you.action;
            const advanceSoon = (ms) =>
                setTimeout(() => host.state.phase === s.phase && host.state.round === s.round && host.request("advancePhase", {}), ms);
            if (action && !action.current && !action.hasVoted && action.targets.length) {
                host.request(action.type === "vote" ? "vote" : "nightAction", { targetId: action.targets[0] });
            } else if (s.phase === "discussion") {
                advanceSoon(80); // give the AI players a moment to talk
            } else if (s.phase === "morning" || !s.you.alive || !action) {
                advanceSoon(30);
            }
        }
        return false;
    }, 20000, "game over");
    return host;
}

describe("AI players", () => {
    it("are unavailable unless the server has a provider", async () => {
        env = await startServer({ llmProvider: null });
        const host = env.connect();
        await host.connected;
        await host.request("createGame", { name: "Alice" });
        await host.waitForState((s) => s.phase === "lobby");
        expect(host.state.features.aiPlayers).toBe(false);
        expect(await host.request("addBot", { kind: "llm" })).toEqual({ ok: false, error: "AI players are not enabled on this server." });
        expect(await host.request("addBot", { kind: "random" })).toEqual({ ok: true });
        expect((await host.request("addBot", { kind: "genius" })).ok).toBe(false);
    });

    it("a full game with AI players runs to a win, and they chat through normal validation", async () => {
        const provider = cooperativeProvider();
        const host = await playWithAi(provider);
        expect(["town", "mafia"]).toContain(host.state.winner.team);
        expect(host.chats.some((m) => m.from?.name.startsWith("AI ") && m.text === "I have my eye on someone.")).toBe(true);
        expect(provider.prompts.length).toBeGreaterThan(0);
    }, 30000);

    it("a misbehaving model can't make illegal moves or oversized posts; the game still finishes", async () => {
        const host = await playWithAi(hostileProvider());
        expect(host.state.phase).toBe("ended");
        const aiLines = host.chats.filter((m) => m.from?.name.startsWith("AI "));
        expect(aiLines.length).toBeGreaterThan(0);
        for (const m of aiLines) expect(m.text.length).toBeLessThanOrEqual(300);
    }, 30000);
});
