// Match orchestration: everything between "room is full" and "someone won".
// Wraps the Game engine with mode-specific flows — single games for classic /
// duel / team play, and draft → build → best-of-three (with sideboarding)
// for the draft formats. Draft-phase prompts live here, not in the engine,
// because they need to run for both players simultaneously.
import { Game } from "./engine/game.js";
import { buildDeck, cards, shuffle } from "./gamedata.js";

export const MODES = {
  classic: { label: "Classic", players: [2, 3, 4], auth: false, kind: "shared" },
  structure: { label: "Structure Duel", players: [2], auth: true, kind: "duel", deckMin: 45 },
  power: { label: "Power Duel", players: [2], auth: true, kind: "duel", deckMin: 12, singleton: true },
  quickdraft: { label: "Quick Draft", players: [2], auth: true, kind: "draft" },
  winston: { label: "Winston Draft", players: [2], auth: true, kind: "draft" },
  "team-open": { label: "Open Team", players: [4], auth: true, kind: "team" },
  "team-closed": { label: "Closed Team", players: [4], auth: true, kind: "team" },
};

/** null if the deck is legal for the mode, else a human-readable reason. */
export function deckProblem(modeId, deckCards) {
  const m = MODES[modeId];
  if (!m || m.kind !== "duel") return null;
  if (!Array.isArray(deckCards) || deckCards.length < m.deckMin) {
    return `${m.label} needs at least ${m.deckMin} cards (this deck has ${deckCards?.length ?? 0}).`;
  }
  if (m.singleton && new Set(deckCards).size !== deckCards.length) {
    return `${m.label} allows only one copy of each card.`;
  }
  return null;
}

const cardInfo = (num) => {
  const c = cards[num];
  return {
    num: c.num,
    name: c.name,
    color: c.color,
    rarity: c.rarity,
    primary: c.primary,
    secondary: c.secondary,
    effect: c.effect,
    bang: c.bang,
    image: c.image,
  };
};

let DRAFT_ID = 0;
const draftCard = (num) => ({ id: ++DRAFT_ID, num });

export class Match {
  /**
   * players: [{seat, name, deckCards|null}] — deckCards only for duel modes.
   * onUpdate(): push fresh state to all connected players.
   */
  constructor({ mode, playerCount, deckMode, players, onUpdate }) {
    this.mode = mode;
    this.def = MODES[mode];
    this.playerCount = playerCount;
    this.deckMode = deckMode;
    this.players = players;
    this.onUpdate = onUpdate || (() => {});

    this.phase = "starting"; // starting | draft | build | game | sideboard | over
    this.pending = new Map(); // seat -> {spec, resolve} (match-level prompts)
    this.game = null;
    this.bo3 = this.def.kind === "draft";
    this.gameWins = [0, 0];
    this.gameNo = 0;
    this.pools = players.map((p) => (p.deckCards ? p.deckCards.map(draftCard) : [])); // [{id, num}]
    this.decks = players.map((p) => (p.deckCards ? [...p.deckCards] : [])); // card nums
    this.matchWinner = null; // seat
    this.log = [];
  }

  start() {
    this.run().catch((e) => {
      console.error("Match crashed:", e);
      this.log.push(`⚠ Internal error: ${e.message}`);
      this.push();
    });
  }

  push() {
    this.onUpdate();
  }

  async run() {
    if (this.def.kind === "draft") {
      if (this.mode === "quickdraft") await this.runQuickDraft();
      else await this.runWinston();
      // Winston: fewer than 12 cards drafted = automatic loss
      const short = [0, 1].find((s) => this.pools[s].length < 12);
      if (short != null) {
        this.log.push(
          `${this.players[short].name} drafted fewer than 12 cards and automatically loses the match.`
        );
        return this.finish(1 - short);
      }
      await this.buildPhase(
        "build",
        this.mode === "quickdraft"
          ? "Build your deck: you may remove up to four cards (keep at least twelve)."
          : "Build your deck: remove any cards you like, but keep at least twelve."
      );
    }

    while (this.matchWinner == null) {
      this.gameNo++;
      this.phase = "game";
      this.push();
      const winner = await this.playGame();
      if (!this.bo3) return this.finish(winner);
      // team/classic never reach here; bo3 winners are seats 0/1
      this.gameWins[winner]++;
      this.log.push(
        `${this.players[winner].name} wins game ${this.gameNo} (${this.gameWins[0]}–${this.gameWins[1]}).`
      );
      if (this.gameWins[winner] >= 2) return this.finish(winner);
      await this.buildPhase(
        "sideboard",
        "Sideboard: adjust your deck from your drafted cards (keep at least twelve)."
      );
    }
  }

  finish(winnerSeat) {
    this.matchWinner = winnerSeat;
    this.phase = "over";
    this.push();
  }

  playGame() {
    const engineMode =
      this.def.kind === "duel" || this.def.kind === "draft"
        ? "duel"
        : this.def.kind === "team"
          ? this.mode
          : "classic";
    return new Promise((resolve) => {
      this.game = new Game({
        playerCount: this.playerCount,
        deckMode: this.deckMode,
        mode: engineMode,
        deckLists: engineMode === "duel" ? this.decks.map((d) => [...d]) : null,
        onUpdate: () => this.push(),
        onLog: () => this.push(),
        onGameOver: (winner) => resolve(winner),
      });
      for (const p of this.players) this.game.addPlayer(p.name);
      this.game.start();
    });
  }

  // ---------- match-level prompts (draft / build) ----------

  prompt(seat, spec) {
    return new Promise((resolve) => {
      this.pending.set(seat, { spec, resolve });
      this.push();
    });
  }

  /** Single entry point for player answers in any phase. */
  answer(seat, ans) {
    if (this.game && this.phase === "game") return this.game.answerPrompt(seat, ans);
    const p = this.pending.get(seat);
    if (!p || !this.validate(p.spec, ans)) return false;
    this.pending.delete(seat);
    p.resolve(ans);
    return true;
  }

  validate(spec, a) {
    if (!a || typeof a !== "object") return false;
    switch (spec.type) {
      case "draftPick": {
        if (!Array.isArray(a.ids) || a.ids.length !== spec.pick) return false;
        if (new Set(a.ids).size !== a.ids.length) return false;
        return a.ids.every((id) => spec.cards.some((c) => c.id === id));
      }
      case "winston":
        return typeof a.take === "boolean" && (a.take || spec.canSkip);
      case "trim": {
        if (!Array.isArray(a.ids)) return false;
        if (new Set(a.ids).size !== a.ids.length) return false;
        if (a.ids.length < spec.min) return false;
        if (spec.maxRemove != null && a.ids.length < spec.pool.length - spec.maxRemove) return false;
        return a.ids.every((id) => spec.pool.some((c) => c.id === id));
      }
      default:
        return false;
    }
  }

  // ---------- quick draft ----------
  // 4 rounds: draw 6 each, keep 2, pass 4; keep 2 of the passed 4, discard 2.
  // The 45-card deck is topped up before round 4 with 3 random discards (48 total dealt).

  async runQuickDraft() {
    this.phase = "draft";
    this.push();
    const deck = buildDeck("random45").map(draftCard);
    const discards = [];
    for (let round = 1; round <= 4; round++) {
      if (round === 4) {
        // need 12 cards but only 9 remain: shuffle 3 random discards back in
        shuffle(discards);
        deck.push(...discards.splice(0, 3));
        shuffle(deck);
        this.log.push("Three discarded cards are shuffled back in for the last draft round.");
      }
      const dealt = [deck.splice(0, 6), deck.splice(0, 6)];
      const firstPicks = await Promise.all(
        [0, 1].map((s) =>
          this.prompt(s, {
            type: "draftPick",
            round,
            step: 1,
            cards: dealt[s].map((c) => ({ ...c, ...cardInfo(c.num) })),
            pick: 2,
            text: `Draft round ${round} of 4 — keep two of these six. The other four are passed to your opponent.`,
          })
        )
      );
      const passed = [];
      for (const s of [0, 1]) {
        const keepIds = new Set(firstPicks[s].ids);
        this.pools[s].push(...dealt[s].filter((c) => keepIds.has(c.id)));
        passed[s] = dealt[s].filter((c) => !keepIds.has(c.id));
      }
      const secondPicks = await Promise.all(
        [0, 1].map((s) =>
          this.prompt(s, {
            type: "draftPick",
            round,
            step: 2,
            cards: passed[1 - s].map((c) => ({ ...c, ...cardInfo(c.num) })),
            pick: 2,
            text: `Round ${round} — your opponent passed you these four. Keep two; the others are discarded face down.`,
          })
        )
      );
      for (const s of [0, 1]) {
        const keepIds = new Set(secondPicks[s].ids);
        this.pools[s].push(...passed[1 - s].filter((c) => keepIds.has(c.id)));
        discards.push(...passed[1 - s].filter((c) => !keepIds.has(c.id)));
      }
      this.push();
    }
  }

  // ---------- winston draft ----------

  async runWinston() {
    this.phase = "draft";
    this.push();
    const deck = buildDeck("random45").map(draftCard);
    const piles = [[deck.shift()], [deck.shift()], [deck.shift()]];
    let turn = Math.floor(Math.random() * 2);
    this.log.push(`${this.players[turn].name} drafts first.`);

    while (piles.some((p) => p.length) || deck.length) {
      let took = false;
      for (let pi = 0; pi < 3 && !took; pi++) {
        if (!piles[pi].length) continue;
        const laterPiles = piles.slice(pi + 1).some((p) => p.length);
        // with an empty deck, declining the last pile would draft nothing —
        // the pile must be taken so every card gets drafted
        const canSkip = deck.length > 0 || laterPiles;
        const a = await this.prompt(turn, {
          type: "winston",
          pileIndex: pi,
          pileSizes: piles.map((p) => p.length),
          deckCount: deck.length,
          cards: piles[pi].map((c) => ({ ...c, ...cardInfo(c.num) })),
          canSkip,
          text: `Pile ${pi + 1} (only you can see it). Take all ${piles[pi].length} card${piles[pi].length > 1 ? "s" : ""}, or pass to ${canSkip ? (laterPiles || deck.length ? "look further" : "draw") : "—"}?`,
        });
        if (a.take) {
          this.pools[turn].push(...piles[pi]);
          piles[pi] = [];
          took = true;
          this.log.push(`${this.players[turn].name} drafts pile ${pi + 1}.`);
        }
        if (deck.length) piles[pi].push(deck.shift());
      }
      if (!took && deck.length) {
        this.pools[turn].push(deck.shift());
        this.log.push(`${this.players[turn].name} draws the top card of the deck.`);
      }
      this.push();
      turn = 1 - turn;
    }
  }

  // ---------- deck building / sideboarding ----------

  async buildPhase(phase, text) {
    this.phase = phase;
    this.push();
    await Promise.all(
      [0, 1].map(async (s) => {
        const pool = this.pools[s];
        if (pool.length <= 12) {
          this.decks[s] = pool.map((c) => c.num); // nothing to cut
          return;
        }
        const a = await this.prompt(s, {
          type: "trim",
          pool: pool.map((c) => ({ ...c, ...cardInfo(c.num) })),
          min: 12,
          maxRemove: phase === "build" && this.mode === "quickdraft" ? 4 : null,
          text,
        });
        const keep = new Set(a.ids);
        this.decks[s] = pool.filter((c) => keep.has(c.id)).map((c) => c.num);
      })
    );
  }

  // ---------- client state ----------

  stateFor(seat) {
    return {
      seat,
      mode: this.mode,
      modeLabel: this.def.label,
      kind: this.def.kind,
      phase: this.phase,
      players: this.players.map((p) => ({ seat: p.seat, name: p.name })),
      bo3: this.bo3,
      gameWins: this.bo3 ? [...this.gameWins] : null,
      gameNo: this.gameNo,
      pool: this.def.kind === "draft" ? this.pools[seat]?.map((c) => ({ ...c, ...cardInfo(c.num) })) : null,
      poolCounts: this.def.kind === "draft" ? this.pools.map((p) => p.length) : null,
      prompt: this.pending.get(seat)?.spec ?? null,
      waitingOnSeats: [...this.pending.keys()],
      matchWinner: this.matchWinner,
      log: this.log.slice(-50),
    };
  }
}
