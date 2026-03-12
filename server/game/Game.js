import { PhaseEngine } from "./PhaseEngine.js"

export class Game {

    constructor(id) {
        this.id = id;
        this.players = [];
        this.phase = new PhaseEngine();
        this.round = 1;
        this.gameState = "lobby";
        this.chatLog = [];
        this.events = [];
        this.winner = null;
    }

    addPlayer({ id, name }) {
        this.players.push({ id, name, role: null, alive: true, memory: [] });
    }

    getPlayer(name) {
        return this.players.find(p => p.name === name);
    }

    assignRoles() {
        const rolePool = Game.shuffle(Game.buildRolePool(this.players.length));

        this.players.forEach((player, index) => {
            player.role = rolePool[index];
        });
    }

    activatePlayers() {
        return this.players
            .filter(p => p.alive)
            .map(p => ({ name: p.name, role: p.role }));
    }

    mafiaKillList() {
        return this.players
            .filter(p => p.alive && p.role === "Mafia")
            .map(p => p.name);
    }

    killPlayer(name) {
        const player = this.getPlayer(name);
        if (player) player.alive = false;
    }

    setPhase(phase) {
        this.phase = phase;
        this.events.push(`Phase changed to ${phase}`);
    }

    nextRound() {
        this.round++;
        this.events.push(`Round ${this.round} started`);
    }

    checkWinCondition() {
        const alive = this.players.filter(p => p.alive);
        const mafiaAlive = alive.filter(p => p.role === "Mafia").length;
        const townAlive = alive.length - mafiaAlive;

        if (mafiaAlive === 0) {
            this.gameState = "ended";
            return { winner: "Villagers", reason: "All Mafia eliminated" };
        }

        if (mafiaAlive >= townAlive) {
            this.gameState = "ended";
            return { winner: "Mafia", reason: "Mafia control the vote" };
        }

        return null;
    }

    static shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    static buildRolePool(playerCount) {
        const mafiaCount = Math.max(1, Math.floor(playerCount / 3));
        return [
            ...Array(mafiaCount).fill('Mafia'),
            'Detective',
            'Doctor',
            ...Array(playerCount - mafiaCount - 2).fill('Villager')
        ];

    }
}