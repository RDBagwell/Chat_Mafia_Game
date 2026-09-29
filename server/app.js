import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import { loadConfig } from "./config.js";
import { GameManager } from "./game/GameManager.js";
import { SocketController } from "./sockets/SocketController.js";
import { defaultBotFactory } from "./players/botFactory.js";

export const CLIENT_DIR = fileURLToPath(new URL("../client", import.meta.url));

export function defaultLog(level, message) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    if (level === "error") console.error(line);
    else console.log(line);
}

/**
 * Builds the HTTP + Socket.io server without listening, so tests can start
 * isolated instances. `botFactory` is how Phase 4 controllers plug in.
 */
export function createServer({ config = loadConfig(), log = defaultLog, botFactory = defaultBotFactory, scheduler } = {}) {
    const allowed = new Set(config.allowedOrigins);
    const app = express();
    app.disable("x-powered-by");
    if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);

    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'"],
                    imgSrc: ["'self'", "data:"],
                    connectSrc: ["'self'", sameHostWebSocket],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'none'"],
                    formAction: ["'none'"],
                    frameAncestors: ["'none'"],
                    ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
                },
            },
            referrerPolicy: { policy: "no-referrer" },
            strictTransportSecurity: config.isProduction ? { maxAge: 31536000 } : false,
            xFrameOptions: { action: "deny" },
        })
    );

    // CORS: only allow-listed origins, never "*".
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Methods", "GET");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });

    app.get("/healthz", (req, res) => res.json({ ok: true }));
    if (config.serveClient) app.use(express.static(CLIENT_DIR, { index: "index.html", dotfiles: "ignore" }));
    app.use((req, res) => res.status(404).type("text/plain").send("Not found"));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        log("error", `http error: ${err?.message}`);
        res.status(500).type("text/plain").send("Server error");
    });

    const httpServer = http.createServer(app);
    const io = new Server(httpServer, {
        serveClient: false,
        transports: ["websocket"],
        maxHttpBufferSize: config.maxHttpBufferSize,
        cors: { origin: [...allowed], methods: ["GET", "POST"] },
        // WebSocket upgrades are not covered by CORS, so check Origin here too.
        allowRequest: (req, callback) => callback(null, allowed.has(req.headers.origin)),
    });

    const manager = new GameManager(config, {
        transport: { toRoom: (room, event, payload) => io.to(room).emit(event, payload) },
        botFactory: botFactory ? (session) => botFactory(session, config) : null,
        log,
        ...(scheduler ? { scheduler } : {}),
    });
    const sockets = new SocketController(io, manager, config, log);
    manager.startSweeper();

    return {
        app,
        httpServer,
        io,
        manager,
        config,
        listen(port = config.port) {
            return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port)));
        },
        async close() {
            manager.stop();
            sockets.stop();
            await new Promise((resolve) => io.close(() => resolve()));
        },
    };
}

/** Allows the page served by this server to open a WebSocket back to the same host. */
function sameHostWebSocket(req) {
    const host = String(req.headers.host || "");
    if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return "'self'";
    return `${req.secure ? "wss" : "ws"}://${host}`;
}
