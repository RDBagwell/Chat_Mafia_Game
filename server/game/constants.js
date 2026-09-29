export const ROLES = Object.freeze({
    MAFIA: "Mafia",
    DETECTIVE: "Detective",
    DOCTOR: "Doctor",
    VILLAGER: "Villager",
});

export const TEAMS = Object.freeze({
    MAFIA: "mafia",
    TOWN: "town",
});

export const PHASES = Object.freeze({
    LOBBY: "lobby",
    NIGHT: "night",
    MORNING: "morning",
    DISCUSSION: "discussion",
    VOTE: "vote",
    ENDED: "ended",
});

export function teamOf(role) {
    return role === ROLES.MAFIA ? TEAMS.MAFIA : TEAMS.TOWN;
}
