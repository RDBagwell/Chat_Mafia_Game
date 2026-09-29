import "dotenv/config";
import { createServer, defaultLog } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = createServer({ config });
const port = await server.listen(config.port);
defaultLog("info", `Mafia server listening on port ${port}`);
defaultLog("info", `Allowed origins: ${config.allowedOrigins.join(", ")}`);

process.on("uncaughtException", (err) => defaultLog("error", `uncaught: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => defaultLog("error", `unhandled rejection: ${err?.stack || err}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
        await server.close();
        process.exit(0);
    });
}
