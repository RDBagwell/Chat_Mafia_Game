import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A minimal fake DOM. Any attempt to parse HTML (innerHTML, outerHTML,
 * insertAdjacentHTML) throws, so if a render path ever used them with user
 * data the test fails. Text is only stored as data.
 */
class FakeNode {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.listeners = {};
        this._text = "";
        this.className = "";
    }
    set innerHTML(_) { throw new Error("innerHTML used"); }
    get innerHTML() { throw new Error("innerHTML used"); }
    set outerHTML(_) { throw new Error("outerHTML used"); }
    insertAdjacentHTML() { throw new Error("insertAdjacentHTML used"); }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...nodes) { this.children.push(...nodes); }
    all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : []))]; }
}

beforeAll(() => {
    globalThis.document = {
        createElement: (tag) => new FakeNode(tag),
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    };
});

const PAYLOADS = ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", '"><svg onload=alert(1)>'];

function view(overrides = {}) {
    return {
        phase: "vote",
        round: 1,
        settings: { revealRoleOnDeath: true },
        roleCounts: { Mafia: 1 },
        you: { id: "p_1", name: PAYLOADS[0], role: "Detective", alive: true, isHost: true, action: { type: "vote", targets: ["p_2"], allowSkip: true, hasVoted: false, current: null }, investigations: [{ round: 1, targetName: PAYLOADS[1], result: "Mafia" }], readableChannels: ["general"], writableChannels: ["general"], lastProtectedId: null },
        players: [
            { id: "p_1", name: PAYLOADS[0], alive: true, isBot: false, isHost: true, connected: true, kicked: false, role: "Detective" },
            { id: "p_2", name: PAYLOADS[1], alive: true, isBot: false, isHost: false, connected: true, kicked: false, role: null },
        ],
        dayVotes: { p_1: "p_2" },
        mafiaVotes: null,
        nightActions: null,
        ...overrides,
    };
}

describe("client rendering treats user text as inert", () => {
    it("chat messages, player names, role card and vote panel never create markup", async () => {
        const r = await import("../../client/js/render.js");
        const v = view();
        const nodes = [
            ...PAYLOADS.map((text, i) => r.renderChatMessage({ id: i, channel: "general", ts: 0, from: { id: "p_2", name: PAYLOADS[i] }, text }, "p_1")),
            ...v.players.map((p) => r.renderPlayerItem(v, p, {})),
            ...r.renderRoleCard(v),
            ...r.renderActionPanel(v, { onTarget() {}, onSkip() {} }),
        ];
        const all = nodes.flatMap((n) => n.all());
        const tags = new Set(all.map((n) => n.tagName));
        expect(tags.has("IMG") || tags.has("SCRIPT") || tags.has("SVG")).toBe(false);
        const text = nodes.map((n) => n.textContent).join("\n");
        for (const p of PAYLOADS) expect(text).toContain(p);
        // No user text ever lands in an attribute other than aria-label.
        for (const n of all) {
            for (const [k, value] of Object.entries(n.attributes)) {
                if (k !== "aria-label") for (const p of PAYLOADS) expect(value).not.toContain(p);
            }
        }
    });

    it("el() refuses attributes outside its allowlist (e.g. href, src, on*)", async () => {
        const { el } = await import("../../client/js/dom.js");
        expect(() => el("a", { href: "javascript:alert(1)" })).toThrow();
        expect(() => el("img", { src: "x" })).toThrow();
        expect(() => el("div", { onclick: "alert(1)" })).toThrow();
    });
});

describe("client source never parses HTML", () => {
    const dir = fileURLToPath(new URL("../../client/js/", import.meta.url));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));

    it.each(files)("%s has no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval", (file) => {
        const src = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
        expect(src).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function)\b/);
    });

    it("index.html has no inline scripts or inline event handlers", () => {
        const html = fs.readFileSync(new URL("../../client/index.html", import.meta.url), "utf8");
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).toMatch(/Content-Security-Policy/);
    });

    it("the vendored socket.io client matches the installed version", () => {
        const vendored = fs.readFileSync(new URL("../../client/vendor/socket.io.esm.min.js", import.meta.url), "utf8");
        const pkg = JSON.parse(fs.readFileSync(new URL("../../node_modules/socket.io-client/package.json", import.meta.url), "utf8"));
        expect(vendored).toContain(`Socket.IO v${pkg.version}`);
    });
});
