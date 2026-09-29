/**
 * A seat's "brain". GameSession calls these hooks and never cares whether a
 * human (socket) or a bot sits behind them.
 *
 * What a controller receives is exactly what that player may know:
 *   - onState(view): getViewFor(game, playerId) — the same snapshot a human's
 *     browser gets (includes chat history for readable channels when it changes)
 *   - onChat(message): only messages from channels the player can read
 *
 * What a controller may do: call session.handleCommand(playerId, type, payload)
 * — the same validated entry point a human's socket events go through.
 */
export class PlayerController {
    /** Called when the controller takes a seat. */
    attach(session, playerId) {
        this.session = session;
        this.playerId = playerId;
    }

    /** @param {object} _view getViewFor() output for this seat */
    onState(_view) {}

    /** @param {object} _message a chat message this seat may read */
    onChat(_message) {}

    onKicked() {}

    /** The seat no longer belongs to this controller ("kicked", "replaced", "left", "closed"...). */
    detach(_reason) {
        this.session = null;
    }

    /** Submits an action through the same validation a human's socket uses. */
    act(type, payload) {
        if (!this.session) return { ok: false };
        return this.session.handleCommand(this.playerId, type, payload);
    }
}
