const playersDiv = document.getElementById("players");

export function updatePlayers(players) {
    playersDiv.innerHTML = "<h3>Players</h3>";

    players.forEach(player => {
        const div = document.createElement("div");
        div.classList.add("player");
        div.textContent = player.name;
        playersDiv.appendChild(div);
    });
}