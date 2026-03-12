import { on } from "./socket.js";
import { addMessage, addSystemMessage } from "./chat.js";
import { updatePlayers } from "./player.js";
import { createGame, joinGame, startGame, sendChat } from "./game.js";

const usernameInput = document.getElementById("username");
const roomIdInput = document.getElementById("roomId");
const messageInput = document.getElementById("messageInput");
const snackbar = document.getElementById("snackbar");

// Helper to get and validate common session inputs
function getSessionValues() {
    return {
        userName: usernameInput?.value.trim(),
        gameId: roomIdInput?.value.trim(),
    };
}

document.getElementById("createGameBtn")?.addEventListener("click", () => {
    const { userName } = getSessionValues();
    if (!userName) {
        showError("Enter a username first.");
        return;
    }
    createGame(userName);
});

document.getElementById("joinGameBtn")?.addEventListener("click", () => {
    const { userName, gameId } = getSessionValues();
    if (!userName || !gameId) {
        showError("Username and Room ID are required.");
        return;
    }
    joinGame(userName, gameId);
});

document.getElementById("startGameBtn")?.addEventListener("click", () => {
    const { gameId } = getSessionValues();
    if (!gameId) {
        showError("Enter a room ID first.");
        return;
    }
    startGame(gameId);
});

function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    const { userName, gameId } = getSessionValues();
    if (!userName || !gameId) {
        showError("Username and Room ID are required.");
        return;
    }

    sendChat(gameId, userName, message);
    messageInput.value = "";
}

/* Snackbar Error UI */

function showError(message) {
    if (!snackbar) {
        console.error("Snackbar element missing:", message);
        return;
    }

    snackbar.textContent = message;
    snackbar.classList.add("show");

    setTimeout(() => {
        snackbar.classList.remove("show");
    }, 3000);
}


document.getElementById("sendMessageBtn")?.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
});

/* SOCKET EVENTS */

on("playerJoined", updatePlayers);

on("chatMessage", (data) => {
    try {
        addMessage(data.userName, data.message);
    } catch (err) {
        console.error("Failed to render chat message:", err, data);
    }
});

on("systemMessage", (data) => {
    try {
        addSystemMessage(data.message);
    } catch (err) {
        console.error("Failed to render system message:", err, data);
    }
});

on("error", (data) => {
    showError(data?.message || "Unknown error");
});


// TODO: implement game started UI (e.g. hide lobby, show game board)
on("gameStarted", (game) => {
    console.log("Game started", game);
});

// TODO: implement phase update UI (e.g. update phase indicator, enable/disable actions)
on("phaseUpdate", (game) => {
    console.log("Phase update", game);
});

// TODO: implement game over UI (e.g. show winner banner, offer rematch)
on("gameOver", (game) => {
    console.log("Winner:", game.winner);
});