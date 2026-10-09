# CLAUDE.md

Guidance for Claude (and humans) working in this repo. Read this before changing code. [README.md](README.md) covers the gameplay, setup and deployment steps; [SECURITY.md](SECURITY.md) covers the threat model and every mitigation.

## What this is

An online Mafia (social deduction) game for strangers on the internet:

- **Server:** Node.js 20+, Express 5 and Socket.io 4 in `server/`. It is the single authority for all state, rules, timers, randomness and permissions.
- **Client:** vanilla JS ES modules in `client/`, with **no build step**. It only renders what the server sends and asks for actions.
- **Deployed** as a GitHub Pages client (`.github/workflows/pages.yml`) plus a Render server (`render.yaml`). Live at `https://rdbagwell.github.io/Chat_Mafia_Game/`, with the server at `https://chat-mafia-server.onrender.com`.

**Security is the top priority.** Treat every client message as hostile. If a feature conflicts with a security rule, the security rule wins; flag the conflict to the owner.

## Commands

```bash
npm install        # one package.json at the repo root (there is no server/package.json)
npm run dev        # http://localhost:3000; serves the client too and restarts on change
npm test           # vitest: unit + socket.io integration tests (must stay green on Node 20/22, Linux + Windows)
npm run vendor     # refresh client/vendor/socket.io.esm.min.js after bumping socket.io-client
```

To play solo locally: Create game → Add bot ×4 → Start game.

## Architecture: where things go

```
server/
  server.js              entry point (npm start)
  app.js                 createServer(): helmet/CSP, CORS allowlist, Socket.io, GameManager, bots
  config.js              every tunable and env var (limits, timers, LLM settings)
  sockets/SocketController.js   the Socket.io boundary: admission, per-IP limits, zod validation, dispatch
  game/
    Game.js              pure state + rules (no sockets, no timers)
    PhaseEngine.js       phase transitions: lobby → (night → morning → discussion → vote)* → ended
    NightResolver.js / DayResolver.js   resolve night actions / day votes
    EventBuilder.js      builds every event object (structured, with `visibility`)
    GameSession.js       one running game: seats, timers, host logic, chat delivery, handleCommand()
    GameManager.js       registry of games, caps, idle cleanup
    channels.js          canRead / canWrite for chat channels: the ONLY place channel permissions live
    view.js              getViewFor(): the ONLY way game state leaves the server
  players/
    PlayerController.js  seat interface (onState / onChat / act); HumanController, RandomBot
    llm/                 LLMPlayer stub, prompt builder, token budget, Anthropic provider skeleton
  security/              validation.js (zod schemas, name/chat sanitising), rateLimit.js, random.js
client/
  js/dom.js              el(): the ONLY way the client builds DOM (textContent only)
  js/render.js           pure render helpers (data in, nodes out)
  js/app.js              screens, state, socket events
  js/net.js              socket connection + request() with acks
  config.js              server URL; empty locally, generated at deploy time by scripts/build-pages.mjs
```

## Invariants: don't break these

1. **One path out.** All state sent to any client or bot goes through `getViewFor(game, playerId)` in `server/game/view.js`. Never `emit` game state built anywhere else. To expose something new, add it there, with a visibility rule.
2. **One path in.** Every in-game action, from a human socket or a bot, goes through `GameSession.handleCommand()`, which runs the zod schema, rate limits and rule checks. Bots and the LLM player must never mutate `Game` directly.
3. **Identity comes from the server.** Use `socket.data.seat`, set only after create/join/resume. Never trust a client-supplied name, role, host flag, alive flag or game ID. Host rights are `game.hostId`.
4. **Channel permissions live only in `channels.js`**, and are re-checked on every message. Socket.io rooms are re-synced from `canRead` before every send; room membership alone is not the check.
5. **Legal targets come from `availableAction()`** in `view.js`. The server validates submitted targets against that same list (no Mafia teammates, no dead players, no Doctor repeat protection, no Detective self-investigation).
6. **Every client event has a strict zod schema** in `security/validation.js`. A new event needs a new schema, and must be added to `GAME_COMMANDS` if it's an in-game action. Errors returned to clients come from the small fixed `ERRORS` set in `GameSession.js`, so they never echo internals or hidden state.
7. **No `innerHTML` (or `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`) anywhere in the client.** Build DOM with `el()` from `client/js/dom.js`. `test/unit/client-xss.test.js` scans for these and fails if any appear.
8. **No inline scripts or styles in `client/index.html`.** The CSP forbids them, both in helmet and in the page's meta tag.
9. **Secrets live in env vars only.** `.env` is gitignored, and `.env.example` documents the variables. The Anthropic key must never reach a view, event, error or log; a test checks this.
10. **Logs never contain chat text or tokens.**

## Conventions

- **Dependencies are pinned exactly.** The approved set is express, socket.io, dotenv, zod, helmet; plus vitest and socket.io-client for development. **Ask the owner before adding any other dependency**, including `@anthropic-ai/sdk`.
- **vitest is held at 4.x.** vitest 5 needs Node ≥ 22.12, and the project supports Node 20+.
- **Use npm 11 when changing dependencies.** npm 10.9.x crashes with `Cannot read properties of null (reading 'edgesOut')` when adding vitest; use `npx npm@11 install`. `npm ci` works fine with npm 10.
- Keep the existing class structure (Game / PhaseEngine / resolvers / GameSession). Engine code stays free of sockets; the transport is injected.
- Gameplay choices that were left open follow standard Mafia conventions, and are recorded in the merged PR [#1](https://github.com/RDBagwell/Chat_Mafia_Game/pull/1) under "Decisions and conventions". Examples: Mafia count is `floor(n/3.5)`, ties execute nobody, and mid-game seats are kept until the game ends.
- Commit messages describe the change and its reason. Put each logical change in its own commit.

## Testing

- **Unit tests** (`test/unit/`) cover the engine, view, channels, validation, config, the Pages build, the LLM plumbing, and the client XSS guarantees (using a fake DOM).
- **Integration tests** (`test/integration/`) start a real server with `startServer()` from `test/helpers.js` and connect with `socket.io-client`. A new security rule needs an integration test proving a hostile client can't get around it.

Traps I hit:
- **Bots act within 0–5 ms in tests.** A game whose night roles are all bots can resolve the night before your assertion runs. Don't `waitForState(s => s.phase === "night")` in bot games; wait for `phase !== "lobby"` or for the specific outcome you're checking.
- **Windows paths:** never use `new URL(..., import.meta.url).pathname` as a file path, because it breaks on Windows and in paths with spaces. Use `fileURLToPath(new URL(...))`, or pass the `URL` object directly to `fs`.
- **Reserved names:** "Host", "System", "Admin" and similar are rejected by `sanitizeName`, so test players use names like "Alice".
- **Rate limits are real in the dev server.** Game creation is limited to 5 per 10 min per IP; restart the server to reset it. Test configs relax all limits except in the tests that check them.

## Deployment

- **Client:** pushing to `main` runs `pages.yml`. `scripts/build-pages.mjs` copies `client/` to `_site/`, writes `config.js` from the repo **variable** `GAME_SERVER_URL` (it must be `https://`), and narrows the CSP `connect-src` to that server. GitHub Pages source must be set to "GitHub Actions". Ignore the built-in "pages build and deployment" workflow; it isn't ours.
- **Server:** the Render Blueprint (`render.yaml`) auto-deploys from `main`. `ALLOWED_ORIGINS` must be exactly `https://rdbagwell.github.io`, with no path and no trailing slash. Health check: `/healthz`.
- The free Render tier sleeps after about 15 min idle, so the first connection after that takes 30–60 s. Games are in memory only; a restart ends them.

## Open items

- **AI players:** `server/players/llm/` is plumbing only. `AnthropicProvider.send()` is a TODO pending approval to add `@anthropic-ai/sdk`. It is gated by `ENABLE_LLM_PLAYERS=true` and needs `ANTHROPIC_API_KEY`. Keep the LLM safety rules in SECURITY.md intact: prompts are built only from that player's own view, chat is treated as untrusted, actions use the same validation as humans, and output and spend are capped.
- **Per-IP limits on Render** read `True-Client-IP` (`CLIENT_IP_HEADER`), falling back to X-Forwarded-For hops. This hasn't been verified in production; if players on different networks hit "too fast" errors together, revisit it.
