const chatDiv = document.getElementById("chat");

export function addMessage(userName, message) {
    const div = document.createElement("div");
    div.classList.add("message");

    const chatName = document.createElement("strong");
    chatName.textContent = userName;

    const chatMessage = document.createElement("span");
    chatMessage.textContent = `: ${message}`;

    div.appendChild(chatName);
    div.appendChild(chatMessage);
    
    chatDiv.appendChild(div);
    chatDiv.scrollTop = chatDiv.scrollHeight;
}

export function addSystemMessage(message) {
    const div = document.createElement("div");
    
    div.classList.add("message", "system");
    div.textContent = message;
    
    chatDiv.appendChild(div);
    chatDiv.scrollTop = chatDiv.scrollHeight;
}