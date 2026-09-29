import { z } from "zod";
import { GAME_CODE_ALPHABET, GAME_CODE_LENGTH } from "./random.js";

export const CHANNEL_NAMES = ["general", "mafia", "dead"];

const playerId = z.string().regex(/^p_[0-9a-f]{16}$/);
const rawName = z.string().max(64);
const gameCode = z.string().max(16);
const token = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const settingsSchema = z
    .strictObject({
        nightSeconds: z.number().int().min(10).max(300),
        morningSeconds: z.number().int().min(3).max(60),
        discussionSeconds: z.number().int().min(15).max(900),
        voteSeconds: z.number().int().min(10).max(300),
        revealRoleOnDeath: z.boolean(),
        testMode: z.boolean(),
        mafiaCount: z.number().int().min(1).max(7).nullable(),
        includeDoctor: z.boolean(),
        includeDetective: z.boolean(),
    })
    .partial();

const empty = z.strictObject({});

/** Every event a client may send, and exactly the fields it may carry. */
export const eventSchemas = {
    createGame: z.strictObject({ name: rawName }),
    joinGame: z.strictObject({ gameId: gameCode, name: rawName }),
    resume: z.strictObject({ gameId: gameCode, token }),
    leaveGame: empty,
    updateSettings: z.strictObject({ settings: settingsSchema }),
    startGame: empty,
    addBot: empty,
    kick: z.strictObject({ playerId }),
    advancePhase: empty,
    nightAction: z.strictObject({ targetId: playerId }),
    vote: z.strictObject({ targetId: playerId.nullable() }),
    chat: z.strictObject({ channel: z.enum(CHANNEL_NAMES), text: z.string().min(1).max(2000) }),
    newGame: empty,
};

export const GAME_COMMANDS = new Set([
    "leaveGame",
    "updateSettings",
    "startGame",
    "addBot",
    "kick",
    "advancePhase",
    "nightAction",
    "vote",
    "chat",
    "newGame",
]);

/** Returns { ok: true, data } or { ok: false }. Never exposes zod internals. */
export function validateEvent(event, payload) {
    const schema = Object.hasOwn(eventSchemas, event) ? eventSchemas[event] : null;
    if (!schema) return { ok: false };
    const result = schema.safeParse(payload === undefined ? {} : payload);
    return result.success ? { ok: true, data: result.data } : { ok: false };
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[A-Za-z0-9 _-]{2,20}$/;
const RESERVED_WORDS = new Set(["system", "host", "admin", "server", "moderator", "narrator", "mod"]);

/**
 * ASCII-only on purpose: Unicode letters would allow look-alike names
 * ("Ѕystem" with a Cyrillic S) that impersonate the server or other players.
 */
export function sanitizeName(raw) {
    if (typeof raw !== "string") return { ok: false, error: "Invalid name" };
    const name = raw.trim().replace(/\s+/g, " ");
    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: "Names are 2–20 characters: letters, numbers, spaces, - and _" };
    }
    const words = name.toLowerCase().split(/[ _-]+/).filter(Boolean);
    const squashed = words.join("");
    if (RESERVED_WORDS.has(squashed) || words.some((w) => RESERVED_WORDS.has(w))) {
        return { ok: false, error: "That name is reserved" };
    }
    return { ok: true, value: name };
}

// ---------------------------------------------------------------------------
// Chat text
// ---------------------------------------------------------------------------

// Control characters, line/paragraph separators, zero-width and bidi
// override characters (used to visually spoof text direction).
const STRIP = new RegExp("[\\p{Cc}\\u2028\\u2029\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]", "gu");

export const MAX_CHAT_LENGTH = 500;

export function sanitizeChat(raw) {
    if (typeof raw !== "string") return { ok: false };
    const text = raw.replace(/[\t\r\n]+/g, " ").replace(STRIP, "").trim();
    if (text.length < 1 || text.length > MAX_CHAT_LENGTH) return { ok: false };
    return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// Game codes
// ---------------------------------------------------------------------------

const CODE_PATTERN = new RegExp(`^[${GAME_CODE_ALPHABET}]{${GAME_CODE_LENGTH}}$`);

export function normalizeGameCode(raw) {
    if (typeof raw !== "string") return null;
    const code = raw.replace(/[\s-]/g, "").toUpperCase();
    return CODE_PATTERN.test(code) ? code : null;
}
