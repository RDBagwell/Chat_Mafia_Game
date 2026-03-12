import { Game } from "../game/Game.js";

export class SocketController {
    constructor(io, games) {
        this.io = io;
        this.games = games;
        this.register();
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    register() {
        this.io.on("connection", (socket) => {
            this._log("info", `New player connected: ${socket.id}`);

            socket.on("createGame",  ()       => this._handle(socket, "createGame",  () => this.createGame(socket)));
            socket.on("joinGame",    (data)   => this._handle(socket, "joinGame",    () => this.joinGame(socket, data)));
            socket.on("startGame",   (data)   => this._handle(socket, "startGame",   () => this.startGame(socket, data)));
            socket.on("nightPhase",  (data)   => this._handle(socket, "nightPhase",  () => this.nightPhase(socket, data)));
            socket.on("dayPhase",    (data)   => this._handle(socket, "dayPhase",    () => this.dayPhase(socket, data)));
            socket.on("chatMessage", (data)   => this._handle(socket, "chatMessage", () => this.chatMessage(socket, data)));
            socket.on("disconnect",  ()       => this._handle(socket, "disconnect",  () => this.disconnect(socket)));
        });
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    createGame(socket) {
        // Use a unique ID instead of hardcoded "Test"
        // const gameId = crypto.randomUUID();
        const gameId = "Test";
        const game = new Game(gameId);

        this.games[gameId] = game;

        socket.join(gameId);
        socket.data.gameId = gameId;
        socket.data.isHost = true;

        socket.emit("gameCreated", { gameId });
        this._log("info", `Game created with ID: ${gameId}`);
        console.log(this.games[gameId]);
    }

    joinGame(socket, data) {
        this._log("info", `Player ${data?.userName} is trying to join game: ${data?.gameId}`);
        //  Validate incoming payload before destructuring
        if (!data?.gameId || typeof data.gameId !== "string") {
            return socket.emit("error", { message: "Invalid payload: gameId is required" });
        }
        if (!data?.userName || typeof data.userName !== "string") {
            return socket.emit("error", { message: "Invalid payload: userName is required" });
        }

        const { gameId, userName } = data;
        const game = this.games[gameId];

        this._log("info", `Player ${userName} is trying to join game: ${gameId}`);

        if (!game) {
            return socket.emit("error", { message: "Game not found" });
        }

        if (game.gameState !== "lobby") {
            return socket.emit("error", { message: "Game has already started" });
        }

        //  Acknowledge duplicate joins instead of silently ignoring them
        if (game.players.find((p) => p.name === userName)) {
            return socket.emit("error", { message: "Username already taken in this game" });
        }

        //  Player construction belongs in Game/Player, not the controller
        game.addPlayer({ id: socket.id, name: userName });

        //  Consistently use gameId (not roomId) on socket.data
        socket.data.userName = userName;
        socket.data.gameId = gameId;

        socket.join(gameId);

        this.io.to(gameId).emit("playerJoined", game.players);
        this.io.to(gameId).emit("systemMessage", { message: `${userName} has joined the game.` });
    }

    startGame(socket, data) {
        if (!data?.gameId) {
            return socket.emit("error", { message: "Invalid payload: gameId is required" });
        }

        const { gameId } = data;
        const game = this.games[gameId];

        if (!game) return socket.emit("error", { message: "Game not found" });

        //  Only the host can start the game
        if (!socket.data.isHost) {
            return socket.emit("error", { message: "Only the host can start the game" });
        }

        if (game.players.length < 4) {
            return socket.emit("error", { message: "Not enough players to start the game" });
        }

        game.assignRoles();
        game.gameState = "active";

        //  Send each player only their own role, not the full game state
        game.players.forEach((player) => {
            const playerSocket = this.io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit("gameStarted", this._sanitizeGameForPlayer(game, player.id));
            }
        });
        console.log(game);
        this.io.to(gameId).emit("systemMessage", { message: "The game has started!" });
    }

    nightPhase(socket, data) {
        this._runPhase(socket, data, (game) => game.phase.runNight(game));
    }

    dayPhase(socket, data) {
        this._runPhase(socket, data, (game) => game.phase.runDay(game));
    }

    chatMessage(socket, data) {
        if (!data?.message || typeof data.message !== "string") {
            return socket.emit("error", { message: "Invalid payload: message is required" });
        }

        //  Use gameId — socket.data.roomId was never set, so chat was always broken
        const { gameId, userName } = socket.data;

        if (!gameId) return;

        this.io.to(gameId).emit("chatMessage", {
            userName,
            message: data.message,
            timestamp: new Date().toISOString(),
        });
    }

    disconnect(socket) {
        //  Use gameId — socket.data.roomId was never set, so the message never sent
        const { gameId, userName } = socket.data || {};

        if (gameId && userName) {
            const game = this.games[gameId];

            if (game) {
                //  Remove the player from the game on disconnect
                game.players = game.players.filter((p) => p.id !== socket.id);

                //  Clean up empty games to prevent memory leaks
                if (game.players.length === 0) {
                    delete this.games[gameId];
                    this._log("info", `Game ${gameId} removed (no players remaining)`);
                } else {
                    this.io.to(gameId).emit("playerLeft", game.players);
                    this.io.to(gameId).emit("systemMessage", { message: `${userName} has left the game.` });
                }
            }
        }

        this._log("info", `Disconnected: ${socket.id}`);
    }

    // -------------------------------------------------------------------------
    // Private Helpers
    // -------------------------------------------------------------------------

    /**
     * Wraps every handler in a try/catch so a thrown error never crashes the
     * process. Emits a consistent error payload back to the offending socket.
     */
    _handle(socket, event, fn) {
        try {
            fn();
        } catch (err) {
            this._log("error", `Error in "${event}": ${err.message}`);
            socket.emit("error", { message: "An internal server error occurred" });
        }
    }

    /**
     *  Extracted shared logic from nightPhase/dayPhase to eliminate
     * duplication and centralise the authorization + error checks.
     */
    _runPhase(socket, data, phaseFn) {
        if (!data?.gameId) {
            return socket.emit("error", { message: "Invalid payload: gameId is required" });
        }

        const { gameId } = data;
        const game = this.games[gameId];

        if (!game) return socket.emit("error", { message: "Game not found" });

        //  Prevent non-hosts from triggering phase transitions
        if (!socket.data.isHost) {
            return socket.emit("error", { message: "Only the host can advance the phase" });
        }

        phaseFn(game);

        this.io.to(gameId).emit("phaseUpdate", this._sanitizeGameForBroadcast(game));

        if (game.gameState === "ended") {
            this.io.to(gameId).emit("gameOver", this._sanitizeGameForBroadcast(game));
        }
    }

    /**
     *  Returns a sanitized view of the game for a specific player.
     * Only their own role is included — other players' roles are stripped.
     */
    _sanitizeGameForPlayer(game, socketId) {
        return {
            id: game.id,
            gameState: game.gameState,
            players: game.players.map((p) => ({
                id: p.id,
                name: p.name,
                alive: p.alive,
                // Only reveal the role if it belongs to the requesting socket
                role: p.id === socketId ? p.role : null,
            })),
        };
    }

    /**
     * Returns a sanitized game view safe for broadcasting to all players.
     * All roles are hidden.
     */
    _sanitizeGameForBroadcast(game) {
        return {
            id: game.id,
            gameState: game.gameState,
            players: game.players.map((p) => ({
                id: p.id,
                name: p.name,
                alive: p.alive,
                role: null,
            })),
        };
    }

    /**
     * Centralised logger. Swap this body out for winston/pino in production.
     */
    _log(level, message) {
        const ts = new Date().toISOString();
        console[level === "error" ? "error" : "log"](`[${ts}] [${level.toUpperCase()}] ${message}`);
    }
}