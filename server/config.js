const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function int(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function list(value) {
    return String(value || "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

/**
 * All tunables in one place. Everything can be overridden per test via
 * createServer({ ...overrides }).
 */
export function loadConfig(env = process.env) {
    const isProduction = env.NODE_ENV === "production";
    const allowedOrigins = list(env.ALLOWED_ORIGINS);

    if (allowedOrigins.includes("*")) {
        throw new Error("ALLOWED_ORIGINS must list explicit origins; '*' is not allowed");
    }
    if (isProduction && allowedOrigins.length === 0) {
        throw new Error("ALLOWED_ORIGINS is required in production (e.g. https://<user>.github.io)");
    }
    if (isProduction && allowedOrigins.some((o) => !o.startsWith("https://"))) {
        throw new Error("In production every ALLOWED_ORIGINS entry must be https://");
    }

    return {
        port: int(env.PORT, 3000),
        isProduction,
        allowedOrigins: allowedOrigins.length ? allowedOrigins : DEV_ORIGINS,
        // Number of reverse proxies in front of the app (Render = 1). Used to
        // read the real client IP from X-Forwarded-For for per-IP limits.
        trustProxyHops: int(env.TRUST_PROXY_HOPS, 0),
        serveClient: env.SERVE_CLIENT !== "false",

        maxGames: int(env.MAX_GAMES, 200),
        maxPlayersPerGame: 16,
        maxHttpBufferSize: 4 * 1024,
        chatHistoryLimit: 200,

        reconnectGraceMs: 2 * 60 * 1000,
        hostTransferMs: 60 * 1000,
        idleGameMs: 30 * 60 * 1000,
        emptyGameMs: 10 * 60 * 1000,
        sweepIntervalMs: 60 * 1000,

        limits: {
            // { capacity, windowMs }: at most `capacity` events per window.
            chat: { capacity: 5, windowMs: 5000 },
            action: { capacity: 10, windowMs: 5000 },
            socketEvents: { capacity: 40, windowMs: 10000 },
            joinPerIp: { capacity: 10, windowMs: 60 * 1000 },
            createPerIp: { capacity: 5, windowMs: 10 * 60 * 1000 },
            connectPerIp: { capacity: 30, windowMs: 60 * 1000 },
            maxConcurrentPerIp: int(env.MAX_CONNECTIONS_PER_IP, 20),
        },

        bots: {
            minDelayMs: 1500,
            maxDelayMs: 5000,
            chatChance: 0.25,
        },

        llm: {
            enabled: env.ENABLE_LLM_PLAYERS === "true",
            apiKey: env.ANTHROPIC_API_KEY || null,
            model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
            maxMessageChars: 300,
            minMsBetweenMessages: 8000,
            tokenBudgetPerGame: int(env.LLM_TOKEN_BUDGET_PER_GAME, 60000),
        },
    };
}
