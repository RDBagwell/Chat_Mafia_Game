export const socket = io('http://localhost:3000');

export function on(event, callback) {
    socket.on(event, callback);
}

export function emit(event, data) {
    socket.emit(event, data);
}