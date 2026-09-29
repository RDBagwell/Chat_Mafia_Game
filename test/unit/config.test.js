import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../server/config.js";

describe("config", () => {
    it("never allows a wildcard origin", () => {
        expect(() => loadConfig({ ALLOWED_ORIGINS: "*" })).toThrow();
    });

    it("requires https origins in production", () => {
        expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/required/);
        expect(() => loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "http://x.io" })).toThrow(/https/);
        expect(loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://a.github.io/" }).allowedOrigins).toEqual(["https://a.github.io"]);
    });

    it("keeps LLM players off unless explicitly enabled", () => {
        expect(loadConfig({}).llm.enabled).toBe(false);
        expect(loadConfig({ ENABLE_LLM_PLAYERS: "1" }).llm.enabled).toBe(false);
        expect(loadConfig({ ENABLE_LLM_PLAYERS: "true" }).llm.enabled).toBe(true);
    });
});

describe("Pages build", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    function build(url) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
        fs.cpSync(path.join(root, "client"), path.join(cwd, "client"), { recursive: true });
        execFileSync("node", [path.join(root, "scripts/build-pages.mjs")], { cwd, env: { ...process.env, GAME_SERVER_URL: url }, stdio: "pipe" });
        return cwd;
    }

    it("writes config.js and locks connect-src to the game server", () => {
        const dir = build("https://game.example.com/some/path");
        expect(fs.readFileSync(path.join(dir, "_site/config.js"), "utf8")).toContain('"https://game.example.com"');
        const html = fs.readFileSync(path.join(dir, "_site/index.html"), "utf8");
        expect(html).toContain("connect-src 'self' https://game.example.com wss://game.example.com");
        expect(html).not.toContain("localhost");
    });

    it("refuses a non-https server URL", () => {
        expect(() => build("http://game.example.com")).toThrow();
    });
});
