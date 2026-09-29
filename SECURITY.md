# Security

Chat Mafia is played by strangers on the internet. This document describes what we defend against and how.

**Reporting a vulnerability:** please open a private security advisory on GitHub (**Security** tab → **Report a vulnerability**) rather than a public issue.

## Threat model

**Assets**

- Hidden information: roles, Mafia chat, Dead chat, night actions and their results. Leaking any of these breaks the game.
- Seats and identity: a player's session token, and host rights.
- Server availability: a free-tier instance with little CPU and memory.
- Secrets: the Anthropic API key (future AI players).

**Attackers**

- **A malicious player** with a modified client or raw Socket.io access. They send arbitrary events and payloads, forge fields, replay tokens, spam, and try to read channels or roles they shouldn't.
- **An outsider** who guesses game codes, floods connections, embeds the page in a frame, or tries to inject script through names and chat.
- **A malicious web page** that tries to open a WebSocket to the server from a victim's browser (cross-site WebSocket hijacking).
- **Prompt injection** against future AI players, via chat.

**Out of scope**

- Players colluding out of band (e.g. a dead player telling a friend on Discord). No server can prevent this.
- Volumetric DDoS. Only the hosting provider can absorb it.
- Persistence: all state is in memory, and a restart ends every game.

## Principles

1. **The server is the authority.** All state, rules, timers, randomness and permissions live on the server. The client only renders what it's sent and asks for actions.
2. **Nothing a client says about itself is trusted.** Name, role, host status, alive status and game ID are never read from payloads. Identity comes from `socket.data.seat`, which only the server sets, after a successful create, join or resume.
3. **One path out.** Every piece of game state sent to anyone comes from `getViewFor(game, playerId)` (`server/game/view.js`). Bots and future LLM players get exactly the same view.
4. **One path in.** Every in-game action, whether from a human socket or a bot, goes through `GameSession.handleCommand()`. It validates the payload with zod, checks rate limits and then applies the rules.

## Mitigations

### Hidden information

| Rule | Where |
|---|---|
| Players see only their own role. Mafia also see their teammates. The dead (observers) see all roles. Everyone sees all roles at game over. Roles are revealed on death only if the host setting allows it. | `canSeeRole` in `view.js` |
| Events carry a `visibility` (`public`, `dead`, `mafia`, or a list of player ids), and the view filters them. | `canSeeEvent` in `view.js` |
| Mafia votes are sent only to Mafia and the dead. Doctor and Detective actions are sent only to the dead. Detective results go only to that Detective (and the dead). | `getViewFor`, `GameSession.nightAction` |
| The morning report says only who died, never who was targeted, protected or investigated. | `GameSession.reportNight` |
| Action targets are computed by the server for that exact actor and phase (`availableAction`). A submitted target must be in that list: no Mafia teammates, no dead players, no Detective self-investigation, and no protecting the same player two nights in a row. | `view.js`, `GameSession` |
| Error messages come from a small fixed set (`ERRORS` in `GameSession.js`), so errors can't reveal hidden state. For example, every bad target gets the same "That's not a valid target." | `GameSession.js` |

### Chat channels

`server/game/channels.js` is the single source of truth for `canRead` and `canWrite`:

| Channel | Write | Read |
|---|---|---|
| General | Living players during lobby, discussion and vote; everyone after game over | Everyone |
| Mafia | Living Mafia during the game | Living Mafia and the dead |
| Dead | The dead | The dead |
| System | Server only | Everyone |

- `canWrite` is re-checked on **every** message, whatever rooms the socket is in.
- Delivery to humans uses Socket.io rooms (`game:<id>:<channel>`). Before every broadcast and every chat message, each socket's rooms are re-synced from `canRead`. When a player dies, is kicked or a new game starts, their rooms change immediately. Bots receive chat per recipient, again after a `canRead` check.
- When a seat gains access to a channel (e.g. on death), it receives that channel's history through `getViewFor(..., { includeChat: true })`.
- The dead can't post in General or Mafia, can't vote and can't act at night. Integration tests check each of these.

### Identity, sessions and host rights

- On join, each player gets a **256-bit random token** (`crypto.randomBytes(32)`). The server stores only its SHA-256 hash. The client keeps it in `sessionStorage` and sends it to resume. `socket.id` is never used as identity.
- Public player ids are separate random values, so they reveal nothing about tokens.
- Host rights are tied to the seat (`game.hostId`), never to a client flag. Extra fields such as `isHost` are rejected by the strict schemas.
- **Reconnect:** a valid token restores the seat and sends a fresh snapshot. Lobby seats are released 2 minutes after a disconnect. Mid-game seats are kept for the rest of the game, so role counts and win checks stay correct.
- **Host transfer:** if the host is disconnected for more than 60 seconds, host passes to the connected human who has been connected longest, and it's announced in System chat.
- **Kick:** the host can kick any other player. The target is disconnected, and both their token hash and their normalised name are banned from that game. Mid-game, a kick counts as a death (with role reveal per the setting) and win conditions are re-checked.
- **Game codes:** 6 characters from a 31-letter unambiguous alphabet, generated with `crypto.randomInt` (about 887 million codes). Join and resume attempts are limited to 10 per minute per IP, which makes brute force impractical. "Not found", "full", "already started" and "banned" all return the same message.

### Input validation

- Every client event has a zod `strictObject` schema (`server/security/validation.js`). Unknown events, unknown fields and wrong types are rejected with a generic "Invalid request.". Repeat offenders (20 violations) are disconnected. Zod errors, stack traces and internals are never sent to clients.
- **Names:** trimmed, whitespace collapsed, 2–20 characters of `[A-Za-z0-9 _-]` only. They are ASCII-only on purpose, so homoglyphs like a Cyrillic "Ѕ" can't impersonate other players. Names are unique case- and separator-insensitively, and any name containing the words system/host/admin/server/mod/moderator/narrator is rejected.
- **Chat:** 1–500 characters after trimming. Control characters, zero-width characters and bidi overrides are stripped.

### XSS and browser hardening

- The client builds all DOM through `el()` (`client/js/dom.js`), which sets text only with `textContent` / `createTextNode` and throws on attributes outside an allowlist (no `href`, `src` or `on*`). **There is no `innerHTML` anywhere in the client.** `test/unit/client-xss.test.js` enforces this by scanning the source. It also renders `<img src=x onerror=…>` and `<script>` payloads through a fake DOM that throws on any HTML parsing, and checks that the payloads survive as inert text.
- **CSP** (helmet, for pages served by the Node server): `default-src 'self'`, `script-src 'self'` (no inline scripts), `style-src 'self'`, `connect-src 'self'` plus the same host's WebSocket, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`. helmet also sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and HSTS in production.
- **GitHub Pages can't set headers.** `index.html` therefore carries the same policy in a `<meta>` CSP, and the deploy script narrows `connect-src` to exactly the game server's `https://` and `wss://` origin. `frame-ancestors` is ignored in a meta tag, so the client also refuses to run inside a frame.
- The Socket.io client is vendored (`client/vendor/`) instead of loaded from a CDN, so `script-src 'self'` is enough.

### Cross-origin access

- `ALLOWED_ORIGINS` is an explicit allowlist. `*` is refused at startup, and production requires `https://` origins.
- Socket.io runs **WebSocket-only**. The upgrade request always carries an `Origin` header, which `allowRequest` checks against the allowlist (CORS alone doesn't cover WebSockets). This blocks cross-site WebSocket hijacking.
- Express only adds CORS headers for allow-listed origins.

### Abuse and denial of service

| Limit | Value |
|---|---|
| Socket.io `maxHttpBufferSize` | 4 KB (larger frames disconnect the socket) |
| Chat per player | 5 messages / 5 s |
| Actions per player | 10 / 5 s |
| Any event per socket | 40 / 10 s |
| Join/resume attempts per IP | 10 / min |
| Game creation per IP | 5 / 10 min |
| New connections per IP | 30 / min, max 20 concurrent |
| Players per game | 16 |
| Games per server | 200 (`MAX_GAMES`) |
| Chat history | 200 messages per channel; 500 events per game |
| Cleanup | games idle for 30 min, or with no connected human for 10 min, are removed |

Rate limiters are token buckets that are pruned when full, so memory stays bounded. Per-IP limits use the real client IP: on Render that's `True-Client-IP` (set by Render's Cloudflare edge), with X-Forwarded-For hop counting as a fallback (`CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS`).

### Operations

- Every socket handler and every timer callback is wrapped, so an exception is logged and answered with a generic error instead of crashing the process. `uncaughtException` and `unhandledRejection` are logged.
- Logs never contain chat content or tokens.
- Secrets live in environment variables. `.env` is gitignored, and `.env.example` is committed with no values.
- Production must be served over HTTPS/WSS. Render terminates TLS, the Pages build refuses a non-`https://` server URL, and production refuses non-`https://` origins.
- `npm audit` reports 0 vulnerabilities at the time of writing. CI runs `npm audit --omit=dev`.

## AI (LLM) players

AI players are plumbing only for now (`server/players/llm/`). They are disabled unless `ENABLE_LLM_PLAYERS=true`, and the provider makes no network calls yet. These rules are part of the design, and the code is written so they keep holding once a provider is filled in:

1. **An AI player only knows its own view.** Its controller receives `getViewFor()` snapshots and the chat messages its seat may read, nothing else. `buildPrompt()` takes only that view and transcript, so a model can't leak information it was never given. A test checks that a Villager's prompt contains no hidden roles.
2. **Human chat is untrusted input.** Chat goes into a delimited `<chat untrusted="true">` block that the system prompt describes as data, not instructions. The model's output is parsed into a constrained shape (`{ targetId }`, or plain text for chat), and any output that isn't a legal target for that exact view is discarded.
3. **Same validation as humans.** AI actions go through `session.handleCommand()`, which runs the same zod schemas, permissions, target checks and rate limits. If the model's choice is illegal, the player falls back to a random *legal* move, so the game never stalls.
4. **Caps.** Messages are capped at 300 characters and at one message every 8 s per AI player. A per-game token budget (`LLM_TOKEN_BUDGET_PER_GAME`, default 60,000) is shared by all AI seats. Once it's spent, they stop calling the provider.
5. **The API key never reaches a client.** It's read from `ANTHROPIC_API_KEY` into server config only. It's stored non-enumerably on the provider, so it can't be serialised by accident, and it's never part of a view, event or error. An integration test sets a key and checks that it doesn't appear in any payload.
