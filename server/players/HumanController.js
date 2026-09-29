import { PlayerController } from "./PlayerController.js";

const NOTICES = {
    kicked: "You were removed from the game by the host.",
    replaced: "You joined from another tab or device.",
    closed: "The game was closed.",
};

/** A seat driven by a browser over Socket.io. */
export class HumanController extends PlayerController {
    constructor(socket) {
        super();
        this.socket = socket;
        this.usesRooms = true;
        this.rooms = new Set();
    }

    attach(session, playerId) {
        super.attach(session, playerId);
        this.socket.data.seat = { gameId: session.id, playerId };
        this.socket.data.controller = this;
    }

    onState(view) {
        this.socket.emit("state", view);
    }

    onChat(message) {
        this.socket.emit("chat", message);
    }

    /** Joins/leaves channel rooms so they always match the server's canRead(). */
    syncRooms(membership) {
        for (const [room, member] of membership) {
            if (member && !this.rooms.has(room)) {
                this.socket.join(room);
                this.rooms.add(room);
            } else if (!member && this.rooms.has(room)) {
                this.socket.leave(room);
                this.rooms.delete(room);
            }
        }
    }

    detach(reason) {
        for (const room of this.rooms) this.socket.leave(room);
        this.rooms.clear();
        if (this.socket.data.controller === this) {
            this.socket.data.seat = null;
            this.socket.data.controller = null;
        }
        super.detach(reason);
        if (NOTICES[reason]) {
            this.socket.emit("sessionEnded", { reason, message: NOTICES[reason] });
            this.socket.disconnect(true);
        }
    }
}
