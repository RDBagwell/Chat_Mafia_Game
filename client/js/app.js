import { socket, request } from "./net.js";
import { $, el, setText, show } from "./dom.js";
import {
    CHANNEL_LABELS,
    PHASE_LABELS,
    formatCountdown,
    renderActionPanel,
    renderChatMessage,
    renderPlayerItem,
    renderRoleCard,
    renderSettings,
} from "./render.js";

// Refuse to run inside a frame (clickjacking); the server also sends
// frame-ancestors 'none', but GitHub Pages can't set headers.
if (window.top !== window.self) {
    document.body.replaceChildren(el("p", { text: "This game can't be embedded in other sites." }));
    throw new Error("framed");
}

const SESSION_KEY = "mafia.session";
const CHANNEL_ORDER = ["general", "mafia", "dead", "system"];

const ui = {
    view: null,
    clockOffset: 0,
    chat: { general: [], mafia: [], dead: [], system: [] },
    seen: { general: new Set(), mafia: new Set(), dead: new Set(), system: new Set() },
    unread: new Set(),
    tab: "general",
    lastPhase: null,
};

// ---------------------------------------------------------------------------
// Session (sessionStorage: per-tab, cleared when the tab closes)
// ---------------------------------------------------------------------------

function loadSession() {
    try {
        return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch {
        return null;
    }
}

function saveSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showScreen(name) {
    for (const s of ["landing", "lobby", "game"]) show($(`screen-${s}`), s === name);
    const slot = name === "lobby" ? $("lobby-chat-slot") : name === "game" ? $("game-chat-slot") : null;
    if (slot && $("chat-panel").parentElement !== slot) slot.append($("chat-panel"));
    show($("chat-panel"), Boolean(slot));
}

function toast(message) {
    const node = $("toast");
    setText(node, message);
    show(node, true);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => show(node, false), 3500);
}

function confirmDialog(text) {
    const dialog = $("confirm-dialog");
    setText($("confirm-text"), text);
    return new Promise((resolve) => {
        const done = (value) => {
            $("confirm-ok").onclick = null;
            $("confirm-cancel").onclick = null;
            dialog.close();
            resolve(value);
        };
        $("confirm-ok").onclick = () => done(true);
        $("confirm-cancel").onclick = () => done(false);
        dialog.showModal();
    });
}

function resetToLanding(message) {
    clearSession();
    ui.view = null;
    resetChat();
    showScreen("landing");
    if (message) toast(message);
}

async function act(event, payload) {
    const res = await request(event, payload);
    if (!res?.ok) toast(res?.error || "Something went wrong.");
    return res;
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function initLanding() {
    const params = new URLSearchParams(location.search);
    const code = params.get("game");
    if (code) {
        $("code-input").value = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    }
    try {
        $("name-input").value = localStorage.getItem("mafia.name") || "";
    } catch {
        /* storage may be unavailable */
    }

    const name = () => {
        const value = $("name-input").value.trim();
        try {
            localStorage.setItem("mafia.name", value);
        } catch {
            /* ignore */
        }
        return value;
    };

    const enter = (res) => {
        if (!res?.ok) return toast(res?.error || "Couldn't connect.");
        saveSession({ gameId: res.gameId, token: res.token, playerId: res.playerId });
        resetChat();
        history.replaceState(null, "", location.pathname);
    };

    $("create-btn").addEventListener("click", async () => enter(await request("createGame", { name: name() })));
    $("join-btn").addEventListener("click", async () =>
        enter(await request("joinGame", { gameId: $("code-input").value.trim(), name: name() }))
    );
    $("code-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("join-btn").click();
    });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function resetChat() {
    for (const c of CHANNEL_ORDER) {
        ui.chat[c] = [];
        ui.seen[c] = new Set();
    }
    ui.unread.clear();
    renderChat();
}

function addMessage(message) {
    const channel = message.channel;
    if (!ui.chat[channel] || ui.seen[channel].has(message.id)) return false;
    ui.seen[channel].add(message.id);
    ui.chat[channel].push(message);
    if (ui.chat[channel].length > 300) ui.chat[channel].shift();
    return true;
}

/** Messages shown in a tab: General also shows System lines, so the story reads in order. */
function tabMessages(tab) {
    if (tab !== "general") return ui.chat[tab];
    return [...ui.chat.general, ...ui.chat.system].sort((a, b) => a.id - b.id);
}

function readableTabs() {
    const readable = ui.view?.you.readableChannels ?? ["general", "system"];
    return CHANNEL_ORDER.filter((c) => readable.includes(c));
}

function renderChat() {
    const view = ui.view;
    const tabs = readableTabs();
    if (!tabs.includes(ui.tab)) ui.tab = "general";

    $("chat-tabs").replaceChildren(
        ...tabs.map((tab) =>
            el("button", {
                class: `tab tab-${tab}${tab === ui.tab ? " active" : ""}${ui.unread.has(tab) ? " unread" : ""}`,
                role: "tab",
                "aria-selected": tab === ui.tab ? "true" : "false",
                text: CHANNEL_LABELS[tab],
                onclick: () => {
                    ui.tab = tab;
                    ui.unread.delete(tab);
                    renderChat();
                },
            })
        )
    );

    const log = $("chat-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...tabMessages(ui.tab).map((m) => renderChatMessage(m, view?.you.id)));
    if (atBottom) log.scrollTop = log.scrollHeight;

    const writable = view?.you.writableChannels ?? [];
    const canWrite = writable.includes(ui.tab);
    const input = $("chat-input");
    input.disabled = !canWrite;
    $("chat-send").disabled = !canWrite;
    input.placeholder = canWrite ? `Message ${CHANNEL_LABELS[ui.tab]}…` : chatLockedReason(view);
}

function chatLockedReason(view) {
    if (!view) return "";
    if (ui.tab === "system") return "System messages only";
    if (!view.you.alive && ui.tab !== "dead") return "The dead can only talk in Dead chat";
    if (ui.tab === "general" && view.phase === "night") return "General chat is closed at night";
    return "You can't write here right now";
}

function initChat() {
    $("chat-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = $("chat-input");
        const text = input.value.trim();
        if (!text) return;
        const res = await act("chat", { channel: ui.tab, text });
        if (res?.ok) input.value = "";
    });
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

function onState(view) {
    ui.clockOffset = view.serverNow - Date.now();
    if (view.chat) {
        for (const c of CHANNEL_ORDER) {
            ui.chat[c] = [];
            ui.seen[c] = new Set();
            for (const m of view.chat[c] ?? []) addMessage(m);
        }
    }
    const phaseChanged = ui.lastPhase !== view.phase;
    ui.lastPhase = view.phase;
    ui.view = view;

    if (phaseChanged && view.phase === "night" && view.you.role === "Mafia" && view.you.alive) ui.tab = "mafia";
    if (phaseChanged && ["discussion", "vote", "lobby"].includes(view.phase)) ui.tab = view.you.alive ? "general" : "dead";

    if (view.phase === "lobby") renderLobby(view);
    else renderGame(view);
    renderChat();
    renderTimer();
}

function kick(player) {
    confirmDialog(`Kick ${player.name}? They will be removed and can't rejoin this game.`).then((ok) => {
        if (ok) act("kick", { playerId: player.id });
    });
}

function renderLobby(view) {
    showScreen("lobby");
    document.body.dataset.host = view.you.isHost ? "yes" : "no";
    setText($("lobby-code"), view.gameId);
    const link = `${location.origin}${location.pathname}?game=${encodeURIComponent(view.gameId)}`;
    $("invite-link").value = link;
    setText($("lobby-count"), `Players (${view.players.length}/${view.maxPlayers})`);
    $("lobby-players").replaceChildren(...view.players.map((p) => renderPlayerItem(view, p, { onKick: kick })));
    const needed = view.minPlayers - view.players.length;
    setText(
        $("lobby-hint"),
        view.you.isHost
            ? needed > 0 ? `Waiting for ${needed} more player${needed === 1 ? "" : "s"} (or add bots).` : "Ready when you are."
            : "Waiting for the host to start the game."
    );
    const form = $("settings-form");
    if (!form.contains(document.activeElement)) {
        form.replaceChildren(...renderSettings(view, (key, value) => act("updateSettings", { settings: { [key]: value } })));
    }
}

function renderGame(view) {
    showScreen("game");
    document.body.dataset.host = view.you.isHost ? "yes" : "no";
    document.body.dataset.phase = view.phase;
    setText($("phase-name"), PHASE_LABELS[view.phase] ?? view.phase);
    setText($("phase-round"), view.round ? `Round ${view.round}` : "");
    show($("advance-btn"), view.you.isHost && view.phase !== "ended");
    show($("observer-banner"), !view.you.alive && view.phase !== "ended");

    const over = view.phase === "ended";
    show($("gameover"), over);
    if (over && view.winner) {
        setText($("gameover-title"), view.winner.team === "mafia" ? "The Mafia win!" : "The town wins!");
        setText($("gameover-reason"), `${view.winner.reason}. Everyone's role is shown below.`);
    }

    $("role-card").replaceChildren(...renderRoleCard(view));
    const panel = renderActionPanel(view, {
        onTarget: (targetId) => act(view.phase === "vote" ? "vote" : "nightAction", { targetId }),
        onSkip: () => act("vote", { targetId: null }),
    });
    show($("action-panel"), panel.length > 0 && !over);
    $("action-panel").replaceChildren(...panel);
    $("game-players").replaceChildren(...view.players.map((p) => renderPlayerItem(view, p, { onKick: kick })));
}

function renderTimer() {
    const view = ui.view;
    const node = $("phase-timer");
    if (!view?.phaseEndsAt) return setText(node, "");
    setText(node, formatCountdown(view.phaseEndsAt - (Date.now() + ui.clockOffset)));
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function initButtons() {
    $("copy-invite").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("invite-link").value);
            toast("Invite link copied.");
        } catch {
            $("invite-link").select();
            toast("Press Ctrl+C / ⌘C to copy.");
        }
    });
    $("start-btn").addEventListener("click", () => act("startGame", {}));
    $("add-bot-btn").addEventListener("click", () => act("addBot", {}));
    $("advance-btn").addEventListener("click", () => act("advancePhase", {}));
    $("new-game-btn").addEventListener("click", () => act("newGame", {}));
    const leave = async () => {
        await request("leaveGame", {});
        resetToLanding();
    };
    $("leave-btn").addEventListener("click", leave);
    $("leave-game-btn").addEventListener("click", leave);
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

function setConnection(text, cls) {
    const node = $("connection");
    setText(node, text);
    node.className = `connection ${cls}`;
}

socket.on("connect", async () => {
    setConnection("Connected", "ok");
    const session = loadSession();
    if (!session) {
        if (!ui.view) showScreen("landing");
        return;
    }
    const res = await request("resume", { gameId: session.gameId, token: session.token });
    if (!res?.ok) resetToLanding(res?.error);
});

socket.on("connect_error", () => {
    setConnection("Waking the server… (free hosting can take up to a minute)", "waiting");
    if (!ui.view && !loadSession()) showScreen("landing");
});
socket.on("disconnect", (reason) => {
    setConnection("Reconnecting…", "waiting");
    // The server closes the socket after a kick or when another tab takes the
    // seat; socket.io won't reconnect by itself in that case.
    if (reason === "io server disconnect") setTimeout(() => socket.connect(), 500);
});
socket.on("state", onState);
socket.on("chat", (message) => {
    if (!addMessage(message)) return;
    const tab = message.channel === "system" ? "general" : message.channel;
    if (tab !== ui.tab) ui.unread.add(tab);
    renderChat();
});
socket.on("serverError", (e) => toast(e?.message || "Something went wrong."));
socket.on("sessionEnded", (e) => resetToLanding(e?.message));

initLanding();
initChat();
initButtons();
setInterval(renderTimer, 250);
if (!loadSession()) showScreen("landing");
