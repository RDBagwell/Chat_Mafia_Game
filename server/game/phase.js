import { mafiaKillList, activePlayers, checkWinCondition } from "./engine.js";

/* =========================
   PUBLIC PHASE FUNCTIONS
========================= */

export function nightPhase(game) {
    const { nightActions, randomKill } = buildRandomNightActions(game);
    const result = resolveNightPhase(game, nightActions);
    const event = buildNightEvent(game, result, randomKill);
    game.events.push(event);
}

export function dayPhase(game) {
    const votes = buildRandomVotes(game);
    const result = resolveDayPhase(game, votes);
    const event = buildDayEvent(game, result);
    game.events.push(event);
}


/* =========================
   NIGHT PHASE
========================= */

function buildRandomNightActions(game) {
    const killList = mafiaKillList(game.players);
    const alive = activePlayers(game.players);

    const randomKill =
        killList[Math.floor(Math.random() * killList.length)] ?? null;

    const randomProtect =
        alive[Math.floor(Math.random() * alive.length)]?.name ?? null;

    const randomInvestigate =
        alive[Math.floor(Math.random() * alive.length)]?.name ?? null;

    const nightActions = {
        mafia: [],
        doctor: null,
        detective: null
    };

    for (const player of game.players) {
        if (!player.alive) continue;

        if (player.role === "Mafia") {
            nightActions.mafia.push(randomKill);
        }

        if (player.role === "Doctor") {
            nightActions.doctor = randomProtect;
        }

        if (player.role === "Detective") {
            nightActions.detective = randomInvestigate;
        }
    }

    return { nightActions, randomKill };
}

function resolveNightPhase(game, nightActions) {
    const { mafia = [], doctor = null, detective = null } = nightActions;

    let mafiaKilled = null;
    let detectiveResult = null;
    let doctorSaved = null;

    /* ---- Mafia Vote ---- */

    const voteCount = {};

    mafia.forEach(target => {
        const player = game.players.find(p => p.name === target && p.alive);
        if (player) {
            voteCount[target] = (voteCount[target] || 0) + 1;
        }
    });

    let mafiaTarget = null;

    const votes = Object.entries(voteCount);
    if (votes.length > 0) {
        mafiaTarget = votes.sort((a, b) => b[1] - a[1])[0][0];
    }

    /* ---- Doctor ---- */

    if (doctor) {
        const saved = game.players.find(p => p.name === doctor && p.alive);
        if (saved) doctorSaved = saved.name;
    }

    /* ---- Apply Kill ---- */

    if (mafiaTarget) {
        const targetPlayer = game.players.find(
            p => p.name === mafiaTarget && p.alive
        );

        if (targetPlayer && mafiaTarget !== doctorSaved) {
            targetPlayer.alive = false;
            mafiaKilled = targetPlayer.name;
        }
    }

    /* ---- Detective ---- */

    if (detective) {
        const investigated = game.players.find(
            p => p.name === detective && p.alive
        );

        if (investigated) {
            detectiveResult = {
                player: investigated.name,
                role: investigated.role
            };
        }
    }

    const winCondition = checkWinCondition(game);

    game.phase = "day";

    return {
        mafiaKilled,
        detectiveResult,
        doctorSaved,
        winCondition,
        phase: game.phase,
        round: game.round
    };
}

function buildNightEvent(game, result, randomKill) {
    return {
        round: game.round,
        killType: "night",
        targeted: randomKill,
        death: result.mafiaKilled,
        deathRole: result.mafiaKilled
            ? game.players.find(p => p.name === result.mafiaKilled)?.role ?? null
            : null,
        protected: result.doctorSaved,
        investigated: result.detectiveResult?.player ?? null,
        investigationResult: result.detectiveResult?.role ?? null,
        activePlayers: activePlayers(game.players),
        winCondition: result.winCondition
    };
}

/* =========================
   DAY PHASE
========================= */

function buildRandomVotes(game) {
    const alive = game.players.filter(p => p.alive);
    const votes = {};

    for (const voter of alive) {
        const possibleTargets = alive.filter(p => p.name !== voter.name);
        if (possibleTargets.length === 0) continue;

        const randomTarget =
            possibleTargets[Math.floor(Math.random() * possibleTargets.length)];

        votes[voter.name] = randomTarget.name;
    }

    return votes;
}

function resolveDayPhase(game, votes) {
    const voteCount = {};

    Object.values(votes).forEach(target => {
        const player = game.players.find(p => p.name === target && p.alive);
        if (!player) return;

        voteCount[target] = (voteCount[target] || 0) + 1;
    });

    const entries = Object.entries(voteCount);

    if (entries.length === 0) {
        game.phase = "night";
        return {
            executed: null,
            voteBreakdown: voteCount,
            tie: false,
            winCondition: null,
            phase: game.phase,
            round: game.round
        };
    }

    entries.sort((a, b) => b[1] - a[1]);

    const highestVote = entries[0][1];

    const topTargets = entries
        .filter(([_, count]) => count === highestVote)
        .map(([name]) => name);

    let executed = null;
    let tie = false;

    if (topTargets.length > 1) {
        tie = true;
    } else {
        const targetName = topTargets[0]; // FIXED
        const player = game.players.find(p => p.name === targetName);

        if (player) {
            player.alive = false;
            executed = player.name;
        }
    }

    const winCondition = checkWinCondition(game);

    game.phase = "night";

    return {
        executed,
        voteBreakdown: voteCount,
        tie,
        winCondition,
        phase: game.phase,
        round: game.round
    };
}

function buildDayEvent(game, result) {
    return {
        round: game.round,
        killType: "day",
        executed: result.executed,
        executedRole: result.executed
            ? game.players.find(p => p.name === result.executed)?.role ?? null
            : null,
        voteBreakdown: result.voteBreakdown,
        tie: result.tie,
        activePlayers: activePlayers(game.players),
        winCondition: result.winCondition
    };
}