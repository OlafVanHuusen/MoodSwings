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
server/index.js           Express + Socket.IO server, lobby management
server/gamedata.js        card data normalization + deck building
server/engine/game.js     core game engine (zones, turns, scoring, prompts)
server/engine/effects.js  all 134 card implementations
public/                   landing page + game table UI (vanilla JS)
test/fuzz.test.js         headless fuzz: plays full random games, checks invariants
```

## Tests

```sh
npm test            # fuzz suite (default 12+ games per config)
FUZZ_N=400 npm test # bigger sweep
```

The fuzzer plays complete games with random valid answers to every prompt across
2/3/4 players and both deck modes, asserting zone-conservation invariants, legal
values, and that games always terminate.
