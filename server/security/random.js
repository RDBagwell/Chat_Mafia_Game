import crypto from "node:crypto";

// No 0/O, 1/I/L: codes are read aloud and typed on phones.
export const GAME_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const GAME_CODE_LENGTH = 6;

/** Unguessable, human-friendly game code (crypto.randomInt is uniform, no modulo bias). */
export function generateGameCode(length = GAME_CODE_LENGTH) {
    let code = "";
    for (let i = 0; i < length; i++) {
        code += GAME_CODE_ALPHABET[crypto.randomInt(GAME_CODE_ALPHABET.length)];
    }
    return code;
}

/** 256-bit secret session token, base64url. */
export function generateToken() {
    return crypto.randomBytes(32).toString("base64url");
}

/** Public (non-secret) player id. Random so it reveals nothing about join order or tokens. */
export function generatePlayerId() {
    return "p_" + crypto.randomBytes(8).toString("hex");
}

export function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** In-place Fisher–Yates shuffle using a CSPRNG. */
export function secureShuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

export function secureChoice(array) {
    if (!array.length) return undefined;
    return array[crypto.randomInt(array.length)];
}
