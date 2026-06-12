# Mood Swings — local multiplayer web version

A personal, local-only fan implementation of the Secret Lair card game **Mood Swings**
(designed by Mark Rosewater, © Wizards of the Coast). Card data, rulings notes, and
card scans are fetched from the fan site [moodiest.app](https://moodiest.app) at setup
time and stored locally — they are not committed assets of this project.

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed
by Wizards.

## Setup

```sh
npm install
npm run scrape   # one-time: downloads card data + images from moodiest.app
npm start        # serves http://localhost:3000
```

Open `http://localhost:3000` in two (or more) browser tabs or on devices on your LAN.
One player creates a game (2–4 players, choice of deck mode), the others join via the
open-tables list or the 4-letter code. The game starts automatically when the table is
full and everyone is redirected to the game page.

### Deck modes

- **Random 45** — a fresh random 45-card deck respecting the official rarity mix
  (23 commons / 14 uncommons / 6 rares / 2 mythics), like opening a new copy.
- **All 133** — every unique card shuffled into one deck.

## What's implemented

- **All seven game modes**: Classic (2–4, shared deck), Structure Duel and Power
  Duel (own saved decks), Quick Draft and Winston Draft (draft in-game, best of
  three with sideboarding), and Open/Closed Team play (2v2). Everything except
  Classic uses accounts (username + password) with a deck builder at `/decks`.
- Full rules engine, server-authoritative: turn structure (play one card or pass),
  "To play this card" costs, "After playing this mood" effects, "While in play"
  continuous effects, suppression (incl. durations), value recomputation, copies
  (Creativity), round scoring with extra-scoring effects, after-scoring effects in
  played order, tie-breaking by earliest play, Hurt Feelings (3+ players), and
  first-to-three-round-wins.
- **All 134 card effects** are coded individually (`server/engine/effects.js`),
  following the official extended rules and the per-card rulings notes.
- Interactive prompts for every choice a card requires (choose moods, players,
  colors, numbers, modes, hand cards…), delivered only to the deciding player.
- Reconnect: reloading a game tab re-attaches you to your seat (tokens are kept in
  per-tab `sessionStorage`, so two players can share one browser).

## Project layout

```
scripts/scrape-cards.js   scraper (moodiest.app -> data/cards.json + public/cards/)
data/cards.json           scraped card data (created by npm run scrape)
server/index.js           HTTP + Socket.IO wiring, graceful shutdown
server/config.js          all env-tunable settings in one place
server/lobby.js           rooms, join codes, reconnect tokens, room reaping
server/match.js           mode catalog, drafts, best-of-three + sideboard
server/api.js + db.js     REST auth & saved decks (SQLite, scrypt)
server/security.js        security headers (CSP etc.) + login rate limiting
server/gamedata.js        card data normalization + deck building
server/engine/game.js     core game engine (zones, turns, scoring, prompts)
server/engine/effects.js  all 134 card implementations
public/                   landing / deck builder / game table UI (vanilla JS)
test/                     headless fuzz suites: full random games + match layer
```

## Deployment (Docker Compose)

The app ships as a single container; card data and the SQLite database live in
volumes so the image itself contains no scraped content.

```sh
# 1. get the card data into ./data and ./public/cards (either of these):
npm install && npm run scrape                     # on any machine with Node 22
docker compose run --rm moodswings npm run scrape # or inside the container

# 2. start it
docker compose up -d --build
```

The server listens on port 3000 (change the `ports:` mapping in
`docker-compose.yml`). State to back up: the `./data` directory.

On the host, `./data` must be writable by the container user (uid 1000, the
`node` user) — `chown -R 1000:1000 data` if your server user has a different uid.

### Behind a reverse proxy (recommended for anything beyond your LAN)

Accounts use session cookies, so if you expose the game outside your network put
it behind HTTPS (Caddy, nginx, Traefik) and uncomment in `docker-compose.yml`:

- `COOKIE_SECURE: "1"` — session cookie only sent over HTTPS
- `TRUST_PROXY: "1"` — rate limiting sees real client IPs via `X-Forwarded-For`

The proxy must forward WebSocket upgrades (Caddy does by default; for nginx set
the usual `Upgrade`/`Connection` headers on `/socket.io/`).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port inside the container |
| `DATA_DIR` | `./data` | location of `cards.json` + `app.db` |
| `SESSION_TTL_DAYS` | `365` | login session lifetime |
| `MAX_ROOMS` | `200` | cap on concurrent lobby rooms |
| `ROOM_REAP_MINUTES` | `60` | delete finished/abandoned rooms after this idle time |
| `COOKIE_SECURE` | off | set `1` when serving over HTTPS |
| `TRUST_PROXY` | off | set `1` when behind a reverse proxy |

## Tests

```sh
npm test            # fuzz suite (default 12+ games per config)
FUZZ_N=400 npm test # bigger sweep
```

The fuzzer plays complete games with random valid answers to every prompt across
2/3/4 players and both deck modes, asserting zone-conservation invariants, legal
values, and that games always terminate.
