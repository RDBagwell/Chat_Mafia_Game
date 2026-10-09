import { el } from "./dom.js";

/**
 * Pure render helpers: data in, DOM nodes out. Every piece of user-supplied
 * text (names, chat) goes through el(), which only ever uses textContent.
 */

export const PHASE_LABELS = {
    lobby: "Lobby",
    night: "Night",
    morning: "Morning",
    discussion: "Day — discussion",
    vote: "Day — vote",
    ended: "Game over",
};

export const CHANNEL_LABELS = { general: "General", mafia: "Mafia", dead: "Dead", system: "System" };

const ROLE_BLURBS = {
    Mafia: "Each night, agree with your team on one victim. By day, blend in.",
    Detective: "Each night, investigate one player to learn whether they are Mafia.",
    Doctor: "Each night, protect one player from the Mafia. You can't protect the same player two nights in a row.",
    Villager: "You have no night power. Talk, read people, and vote out the Mafia.",
};

const ACTION_PROMPTS = {
    kill: "Choose tonight's victim",
    protect: "Choose someone to protect",
    investigate: "Choose someone to investigate",
    vote: "Vote to execute",
};

export function playerName(view, id) {
    return view.players.find((p) => p.id === id)?.name ?? "someone";
}

export function renderChatMessage(message, youId) {
    const time = new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (!message.from) {
        return el("li", { class: `msg system channel-${message.channel}` }, el("span", { class: "msg-text", text: message.text }));
    }
    return el(
        "li",
        { class: `msg${message.from.id === youId ? " mine" : ""}` },
        el("span", { class: "msg-time", text: time }),
        el("strong", { class: "msg-name", text: message.from.name }),
        el("span", { class: "msg-text", text: message.text })
    );
}

export function renderPlayerItem(view, player, { onKick } = {}) {
    const you = view.you;
    const badges = [];
    if (player.isHost) badges.push(el("span", { class: "badge host", text: "host" }));
    if (player.isAI) badges.push(el("span", { class: "badge ai", text: "AI" }));
    else if (player.isBot) badges.push(el("span", { class: "badge bot", text: "bot" }));
    if (player.id === you.id) badges.push(el("span", { class: "badge you", text: "you" }));
    if (!player.connected && !player.kicked) badges.push(el("span", { class: "badge offline", text: "offline" }));
    if (player.kicked) badges.push(el("span", { class: "badge kicked", text: "kicked" }));
    if (player.role) badges.push(el("span", { class: `badge role role-${player.role.toLowerCase()}`, text: player.role }));

    const canKick = you.isHost && player.id !== you.id && !player.kicked && view.phase !== "ended";
    return el(
        "li",
        { class: `player${player.alive ? "" : " dead"}` },
        el("span", { class: "player-name", text: player.name }),
        el("span", { class: "badges" }, badges),
        canKick ? el("button", { class: "small danger kick", text: "Kick", "aria-label": `Kick ${player.name}`, onclick: () => onKick?.(player) }) : null
    );
}

export function renderRoleCard(view) {
    const you = view.you;
    const nodes = [el("div", { class: "role-label", text: "Your role" })];
    nodes.push(el("div", { class: `role-name role-${(you.role || "none").toLowerCase()}`, text: you.role || "—" }));
    if (you.role) nodes.push(el("p", { class: "hint", text: ROLE_BLURBS[you.role] }));

    if (you.role === "Mafia") {
        const team = view.players.filter((p) => p.role === "Mafia" && p.id !== you.id).map((p) => p.name);
        nodes.push(el("p", { text: team.length ? `Your teammates: ${team.join(", ")}` : "You are the only Mafia member." }));
    }
    if (you.investigations.length) {
        nodes.push(el("h4", { text: "Your investigations" }));
        nodes.push(
            el(
                "ul",
                { class: "investigations" },
                you.investigations.map((i) =>
                    el("li", {}, `Night ${i.round}: `, el("strong", { text: i.targetName }), ` — ${i.result}`)
                )
            )
        );
    }
    if (view.roleCounts) {
        const counts = Object.entries(view.roleCounts).map(([role, n]) => `${n} ${role}`).join(" · ");
        nodes.push(el("p", { class: "hint", text: `In play: ${counts}` }));
    }
    return nodes;
}

/** The action panel: night action or day vote, only when the player can act. */
export function renderActionPanel(view, { onTarget, onSkip }) {
    const you = view.you;
    const action = you.action;
    const nodes = [];

    if (view.phase === "vote" && view.dayVotes) {
        const entries = Object.entries(view.dayVotes);
        nodes.push(el("h3", { text: "Votes so far" }));
        nodes.push(
            entries.length
                ? el(
                    "ul",
                    { class: "votes" },
                    entries.map(([voter, target]) =>
                        el("li", {}, el("strong", { text: playerName(view, voter) }), " → ", target ? playerName(view, target) : "skip")
                    )
                )
                : el("p", { class: "hint", text: "No votes yet." })
        );
    }

    if (view.mafiaVotes && view.phase === "night") {
        const entries = Object.entries(view.mafiaVotes);
        nodes.push(el("h3", { text: "Mafia votes" }));
        nodes.push(
            entries.length
                ? el("ul", { class: "votes" }, entries.map(([voter, target]) => el("li", {}, el("strong", { text: playerName(view, voter) }), " → ", playerName(view, target))))
                : el("p", { class: "hint", text: "No Mafia votes yet." })
        );
    }

    if (view.nightActions) {
        const { protect, investigate } = view.nightActions;
        nodes.push(el("h3", { text: "Night actions (observer)" }));
        nodes.push(el("p", { text: protect ? `Doctor protects ${playerName(view, protect.targetId)}` : "Doctor hasn't chosen yet." }));
        nodes.push(el("p", { text: investigate ? `Detective investigates ${playerName(view, investigate.targetId)}` : "Detective hasn't chosen yet." }));
    }

    if (!action) {
        if (view.phase === "night" && you.alive && !view.mafiaVotes) nodes.unshift(el("p", { class: "hint", text: "You're asleep. Wait for morning." }));
        if (["morning", "discussion"].includes(view.phase) && you.alive) nodes.unshift(el("p", { class: "hint", text: "Talk it over in General chat. Voting comes next." }));
        return nodes;
    }

    const buttons = action.targets.map((id) => {
        const selected = action.current === id && (action.type !== "vote" || action.hasVoted);
        return el("button", {
            class: `target${selected ? " selected" : ""}`,
            "aria-pressed": selected ? "true" : "false",
            text: playerName(view, id) + (id === you.id ? " (you)" : ""),
            onclick: () => onTarget(id),
        });
    });
    if (action.allowSkip) {
        const skipped = action.hasVoted && action.current === null;
        buttons.push(el("button", { class: `target skip${skipped ? " selected" : ""}`, "aria-pressed": skipped ? "true" : "false", text: "Skip", onclick: () => onSkip() }));
    }
    nodes.unshift(el("div", { class: "targets" }, buttons));
    nodes.unshift(el("h3", { text: ACTION_PROMPTS[action.type] }));
    if (action.type === "protect" && you.lastProtectedId) {
        nodes.splice(1, 0, el("p", { class: "hint", text: `You can't protect ${playerName(view, you.lastProtectedId)} again tonight.` }));
    }
    return nodes;
}

const SETTING_FIELDS = [
    { key: "nightSeconds", label: "Night (seconds)", type: "number", min: 10, max: 300 },
    { key: "discussionSeconds", label: "Discussion (seconds)", type: "number", min: 15, max: 900 },
    { key: "voteSeconds", label: "Vote (seconds)", type: "number", min: 10, max: 300 },
    { key: "morningSeconds", label: "Morning report (seconds)", type: "number", min: 3, max: 60 },
    { key: "mafiaCount", label: "Mafia count (blank = auto)", type: "number", min: 1, max: 7, nullable: true },
    { key: "includeDoctor", label: "Include Doctor", type: "checkbox" },
    { key: "includeDetective", label: "Include Detective", type: "checkbox" },
    { key: "revealRoleOnDeath", label: "Reveal roles when players die", type: "checkbox" },
    { key: "testMode", label: "Test mode (allow 4 players)", type: "checkbox" },
];

export function renderSettings(view, onChange) {
    const editable = view.you.isHost && view.phase === "lobby";
    return SETTING_FIELDS.map((f) => {
        const id = `setting-${f.key}`;
        const value = view.settings[f.key];
        const input =
            f.type === "checkbox"
                ? el("input", { id, type: "checkbox", checked: value, disabled: !editable })
                : el("input", { id, type: "number", min: f.min, max: f.max, step: 1, value: value ?? "", disabled: !editable });
        input.addEventListener("change", () => {
            let next;
            if (f.type === "checkbox") next = input.checked;
            else if (input.value === "" && f.nullable) next = null;
            else next = Math.round(Number(input.value));
            onChange(f.key, next);
        });
        return el("div", { class: `setting ${f.type}` }, el("label", { for: id, text: f.label }), input);
    });
}

export function formatCountdown(ms) {
    if (ms == null) return "";
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
}
