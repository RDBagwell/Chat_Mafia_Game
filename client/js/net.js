import { io } from "../vendor/socket.io.esm.min.js";
import config from "../config.js";

function resolveServerUrl() {
    if (config.serverUrl) return config.serverUrl.replace(/\/+$/, "");
    if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
    return "http://localhost:3000";
}

export const serverUrl = resolveServerUrl();

// WebSocket only: the upgrade request always carries an Origin header, which
// the server checks against its allowlist.
export const socket = io(serverUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 60000, // free hosts can take ~30–60 s to wake up
});

/** Emits with an acknowledgement; resolves to the server's { ok, ... } reply. */
export function request(event, payload = {}) {
    return new Promise((resolve) => {
        if (!socket.connected) {
            resolve({ ok: false, error: "Not connected to the server yet." });
            return;
        }
        socket.timeout(8000).emit(event, payload, (err, res) => {
            resolve(err ? { ok: false, error: "The server didn't answer. Try again." } : res);
        });
    });
}
