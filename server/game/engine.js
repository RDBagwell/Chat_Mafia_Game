
export function createGame() {
    
     return {
        round: 1,
        phase: "night",
        players: [
            { name: "Red", role: null, alive: true, memory: [] },
            { name: "Orange", role: null, alive: true, memory: [] },
            { name: "Yellow", role: null, alive: true, memory: [] },
            // { name: "Green", role: null, alive: true, memory: [] },
            // { name: "Blue", role: null, alive: true, memory: [] },
            // { name: "Purple", role: null, alive: true, memory: [] },
            // { name: "Pink", role: null, alive: true, memory: [] },
            // { name: "White", role: null, alive: true, memory: [] },
            // { name: "Black", role: null, alive: true, memory: [] }
        ],
        chatLog: [], // To store chat messages for LLM players
        events: [], // To store game events for LLM players
        gameState: 'waiting'
    }
}

export function createRandomGame() {
    const players = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Pink", "White", "Black"];

    const rolePool = shuffle(buildRolePool(players.length));
    // console.log('Role Pool:', rolePool);
    return {
        round: 1,
        phase: "night",
        players: players.map((name, index) => ({
            name,
            role: rolePool[index],
            alive: true,
            memory: [] // For LLM players to store information 
        })),
        chatLog: [], // To store chat messages for LLM players
        events: [], // To store game events for LLM players
        gameState: 'waiting'
    }
}

export function mafiaKillList(players) {
    return players.filter(p => p.role !== 'Mafia' && p.alive).map(p => p.name);
}

export function activePlayers(players) {
    return players.filter(p => p.alive).map(p => ({ name: p.name, role: p.role }));
}

/* =========================
   WIN CONDITION
========================= */

export function checkWinCondition(game) {
    const alive = game.players.filter(p => p.alive);
    const mafiaAlive = alive.filter(p => p.role === "Mafia").length;
    const townAlive = alive.length - mafiaAlive;

    if (mafiaAlive === 0) {
        game.gameState = "ended";
        return { winner: "Villagers", reason: "All Mafia eliminated" };
    }

    if (mafiaAlive >= townAlive) {
        game.gameState = "ended";
        return { winner: "Mafia", reason: "Mafia control the vote" };
    }

    return null;
}

export function assignRoles(players) {
    const rolePool = shuffle(buildRolePool(players.length));
    players.forEach((player, index) => {
        player.role = rolePool[index];
    });
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function buildRolePool(playerCount) {
    const mafiaCount = Math.max(1, Math.floor(playerCount / 3));
    return [
        ...Array(mafiaCount).fill('Mafia'),
        'Detective',
        'Doctor',
        ...Array(playerCount - mafiaCount - 2).fill('Villager')
    ];

}