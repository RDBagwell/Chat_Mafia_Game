# Chat Mafia

An online game of **Mafia** (also known as Werewolf) played in your browser. A hidden Mafia picks off the town one night at a time. By day, everyone argues, accuses and votes someone out. Can the town find the Mafia before they're outnumbered?

- Up to 16 players per game, 5 minimum (4 in test mode). Invite friends with a link.
- Server-authoritative: roles, timers, votes and chat permissions all live on the server.
- Add **bots** from the lobby to fill seats or to test a whole game by yourself.
- Optional **AI players** powered by Claude, which talk, bluff and vote like human players (off unless you add an Anthropic API key).

## How to play

| Role | Team | Night action |
|---|---|---|
| **Mafia** (about 1 per 3–4 players) | Mafia | Votes with the other Mafia on one victim. They know each other. |
| **Doctor** | Town | Protects one player from the Mafia. They can protect themselves, but not the same player two nights in a row. |
| **Detective** | Town | Investigates one player and privately learns **Mafia** or **Not Mafia**. |
| **Villager** | Town | None. Talk, read people, vote. |

Each round runs: **Night → Morning report → Day discussion → Day vote**.

- **Night:** the night roles act in secret. The night ends when all of them have acted or the timer runs out. If the Mafia disagree, the target with the most votes is chosen, and ties are broken at random.
- **Morning:** everyone learns who died, plus their role (a host setting, on by default). Nobody learns who was targeted, protected or investigated.
- **Discussion:** living players talk in **General** chat.
- **Vote:** each living player votes for someone or chooses **Skip**. Votes are public. The most votes is executed. A tie, or Skip winning, means nobody dies.
- **Town wins** when every Mafia member is dead. **Mafia win** when they equal or outnumber everyone else. At the end, all roles are revealed.

**Chat channels:** *General* (everyone reads; the living write during the lobby, discussion and vote), *Mafia* (Mafia only; the dead can read it), *Dead* (the dead only) and *System* (server announcements). **Dead players become observers:** they see every role and every night action, but they can only talk in Dead chat.

**The host** (whoever created the game) can change settings, start the game, add bots, end any phase early and kick players. A kicked player can't rejoin that game. If the host is gone for more than about 60 seconds, host passes to the player who has been connected longest.

## Project layout

```
package.json           single package for everything (one lockfile, at the root)
server/                Node.js server (Express 5 + Socket.io 4)
  server.js            entry point (npm start)
  app.js               createServer(): HTTP, helmet/CSP, CORS, Socket.io
  config.js            all tunables and environment variables
  game/                rules engine: Game, PhaseEngine, NightResolver, DayResolver,
                       EventBuilder, GameSession (orchestration), channels.js
                       (chat permissions), view.js (getViewFor)
  players/             seat controllers: HumanController, RandomBot, llm/ (stub)
  security/            zod validation, rate limiting, crypto helpers
  sockets/             SocketController: the Socket.io boundary
client/                static vanilla-JS client (ES modules, no build step)
  config.js            server URL (generated at deploy time)
  vendor/              socket.io client ESM build (npm run vendor)
scripts/build-pages.mjs  builds _site/ for GitHub Pages
test/                  vitest unit + integration tests
render.yaml            Render blueprint for the server
.github/workflows/     tests (ci.yml) and GitHub Pages deploy (pages.yml)
```

## Run it locally

Requires **Node.js 20 or newer**.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The dev server also serves the client and restarts when files change. To play alone, create a game, click **Add bot** four times, then **Start game**. To play with several people on one computer, open extra **private/incognito windows**: each tab keeps its own session in `sessionStorage`.

To try it from a phone on your Wi-Fi, open `http://<your-computer's-LAN-IP>:3000` and add that origin to `ALLOWED_ORIGINS` in `.env` (see `.env.example`).

## Tests

```bash
npm test
```

This runs the engine unit tests and integration tests. The integration tests start a real server and connect with `socket.io-client`. They cover chat permissions, leaks, host-only controls, kicks and bans, validation, rate limits, reconnects, XSS and full bot games.

## Deploy it yourself (free)

GitHub Pages only hosts static files, so the game is deployed in two parts:

- the **client** (the web page) on **GitHub Pages**
- the **server** (the Socket.io game server) on **Render**'s free tier

> **Note:** Render's free tier puts the server to sleep after ~15 minutes without traffic. The first visitor after that waits about 30–60 seconds while it wakes up. The page shows "Waking the server…" during that time.

Do these steps **after this branch is merged into `main`**.

### 1. Create the server on Render

1. Sign in at <https://dashboard.render.com> with your GitHub account.
2. Click **New +** (top right) → **Blueprint**.
3. Under **Connect a repository**, pick **RDBagwell/Chat_Mafia_Game**. If it isn't listed, click **Configure account** / **Connect GitHub** and grant Render access to the repo.
4. Give the blueprint a name (e.g. `chat-mafia`) and keep the **Branch** set to `main`.
5. Render reads `render.yaml` and asks for the value of **`ALLOWED_ORIGINS`**. Enter your GitHub Pages origin: **`https://rdbagwell.github.io`**. Use exactly that: `https://`, lowercase, **no** `/Chat_Mafia_Game` path and **no** trailing slash.
6. Click **Apply**. Wait for the deploy to show **Live** (a few minutes).
7. Open the service **chat-mafia-server** and copy its URL from the top of the page, e.g. `https://chat-mafia-server.onrender.com`. Open `<that URL>/healthz` in a browser. It should show `{"ok":true}`.

*(Prefer not to use a Blueprint? Use **New +** → **Web Service**, pick the repo, and set: Language **Node**, Build Command `npm ci --omit=dev`, Start Command `npm start`, Instance Type **Free**. Under **Advanced**, set Health Check Path `/healthz`, then add the environment variables from `render.yaml`: `NODE_ENV=production`, `ALLOWED_ORIGINS=https://rdbagwell.github.io`, `CLIENT_IP_HEADER=true-client-ip`, `TRUST_PROXY_HOPS=1`, `SERVE_CLIENT=false`.)*

### 2. Tell the client where the server is

1. On GitHub, open the repo → **Settings** → **Secrets and variables** → **Actions**.
2. Choose the **Variables** tab (not Secrets) → **New repository variable**.
3. Name: **`GAME_SERVER_URL`**. Value: the Render URL from step 1.7, e.g. `https://chat-mafia-server.onrender.com`. It must start with `https://`.
4. Click **Add variable**.

### 3. Turn on GitHub Pages

1. Repo → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab → **Deploy client to GitHub Pages** (left list) → **Run workflow** → branch `main` → **Run workflow**. (It also runs automatically on every push to `main`.)
4. When the run is green, the site is live at **<https://rdbagwell.github.io/Chat_Mafia_Game/>**.

### 4. Share the link

Open the Pages URL, enter your name and click **Create game**. In the lobby, click **Copy link**. It looks like `https://rdbagwell.github.io/Chat_Mafia_Game/?game=ABC123`. Send it to friends: the link fills in the game code, and they just type a name and click **Join**.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Stuck on "Waking the server…" for more than 2 minutes | Check the Render service is **Live** and `/healthz` works. Check `GAME_SERVER_URL` is exactly the Render URL, then re-run the Pages workflow. |
| Connects locally but not on Pages | `ALLOWED_ORIGINS` on Render must be exactly `https://rdbagwell.github.io`. After changing it, Render redeploys automatically. |
| The Pages workflow fails with "GAME_SERVER_URL is not set" | Add the variable (step 2) under **Variables**, not **Secrets**. |
| Render deploy fails with "ALLOWED_ORIGINS is required" | Set it in the service → **Environment**. |

## AI players

AI players are seats played by Claude (Anthropic's model). Unlike the random bots, they read the chat, argue a case, bluff when they're Mafia, and choose targets and votes from what they know. They are off by default. When they're on, the host sees an **Add AI player** button in the lobby.

They play under exactly the same rules as people. Each AI player sees only what its own seat would see (its role, its teammates if it's Mafia, and the chats it's allowed to read), and every move goes through the same server checks as a human's. If the model makes an illegal choice, or the API is slow or down, that AI player falls back to a random legal move, so the game never stalls.

### Turn them on (Render)

1. **Get an API key.** Sign in at <https://console.anthropic.com>, add a payment method or credit under **Billing**, then go to **API Keys** → **Create Key**. Copy the key (it starts with `sk-ant-`); it's shown only once.
2. **Add it to Render.** In the Render dashboard, open **chat-mafia-server** → **Environment** → **Add Environment Variable**:
   - `ANTHROPIC_API_KEY` = your key
   - `ENABLE_LLM_PLAYERS` = `true`

   Click **Save Changes**. Render redeploys automatically.
3. **Check it worked.** In the service's **Logs**, look for `AI players enabled (model claude-opus-5-5)`. Then create a game: the lobby shows **Add AI player**.

To run them locally, put the same two variables in your `.env` file and restart `npm run dev`.

### Cost

Every AI turn is an API call billed to your Anthropic account. The default model is `claude-opus-5-5`, run at low effort to keep turns short. A typical game with five AI players costs very roughly **$0.50–$1.50**. All AI players in one game share a token budget (`LLM_TOKEN_BUDGET_PER_GAME`, default 150,000 tokens), which caps a single game at about $3 in the worst case. When the budget runs out, the AI players keep playing with random legal moves and stop chatting. The budget resets for each new game.

To spend less, lower `LLM_TOKEN_BUDGET_PER_GAME`, or set `ANTHROPIC_MODEL` to a cheaper model such as `claude-haiku-5-5`. Anyone who can reach your game can add AI players to a game they host, so keep an eye on usage in the Anthropic Console, where you can also set a monthly spend limit.

### Troubleshooting

| Symptom | Fix |
|---|---|
| No **Add AI player** button | `ENABLE_LLM_PLAYERS` must be exactly `true` and `ANTHROPIC_API_KEY` must be set. Check the Render logs for `AI players enabled`, or for `ANTHROPIC_API_KEY is not set`. |
| AI players act randomly and never chat | Check the Render logs for `LLM ... failed: auth` (wrong or revoked key), `rate_limited` or `unavailable`. After an auth failure the server stops calling the API until it restarts. |

## Configuration

Everything is read from environment variables. See [`.env.example`](.env.example) and [`server/config.js`](server/config.js). Copy `.env.example` to `.env` for local overrides. `.env` is gitignored.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and each mitigation, including the safety rules for AI players.
