import { nightPhase, dayPhase } from "./phase.js";
import { createGame, assignRoles } from "./engine.js";

export function initSocket(io, games) {
    io.on('connection', (socket) => {

        socket.on('createGame', () => {
            const gameId = "Test";
            // const gameId = socket.id;
            const game = createGame();
            game.id = gameId;
            games[gameId] = game;
            socket.join(gameId);
            socket.emit('gameCreated', { gameId, game });
            console.log(`Game created: ${gameId}`);
        });

        socket.on("joinGame", ({ gameId, username }) => {
            const game = games[gameId];
            console.log(`Player ${username} is trying to join game: ${gameId}`);
            if (!game) return socket.emit("error", { error: "Game not found" });

            // Add player if not already added
            if (!game.players.find(p => p.name === username)) {
                game.players.push({ name: username, role: null, alive: true, memory: [] });
                socket.data.username = username;
                socket.data.roomId = gameId;
                socket.join(gameId);
                io.to(gameId).emit("playerJoined", game.players);
                io.to(gameId).emit("systemMessage", { message: `${username} has joined the game.` });
            }
        });

        // Start the game (assign roles)
        socket.on("startGame", ({ gameId }) => {
            const game = games[gameId];
            if (!game) return socket.emit("error", { error: "Game not found" });
            if (game.players.length < 4) return socket.emit("error", { error: "Not enough players to start the game" });

            // // Assign roles to players
            assignRoles(game.players);

            game.gameState = "active";
            io.to(gameId).emit("gameStarted", game);
            io.to(gameId).emit("systemMessage", { message: `The game has started!` });
        });

        socket.on("nightPhase", ({ gameId }) => {
            const game = games[gameId];
            if (!game) return socket.emit("error", { error: "Game not found" });
            nightPhase(game);
            io.to(gameId).emit('phaseUpdate', game);

            if (game.gameState === 'ended') {
                io.to(gameId).emit('gameOver', game);
            }
        });
        
        socket.on("dayPhase", ({ gameId }) => {
            const game = games[gameId];
            if (!game) return socket.emit("error", { error: "Game not found" });
            dayPhase(game);
            io.to(gameId).emit('phaseUpdate', game);

            if (game.gameState === 'ended') {
                io.to(gameId).emit('gameOver', game);
            }
        });

        socket.on("chatMessage", ({ message }) => {
            const { roomId, username } = socket.data;
            if (!roomId) return;
            io.to(roomId).emit("chatMessage", {
                username,
                message,
                timestamp: new Date().toISOString()
            });
        });

        socket.on("disconnect", () => {
            const { roomId, username } = socket.data || {};
            if (roomId && username) {
                io.to(roomId).emit("systemMessage", { message: `${username} has left the room.` });
            }
            console.log('Disconnected:', socket.id);
        });

    });
}