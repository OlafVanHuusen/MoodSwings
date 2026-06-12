// Core Mood Swings game engine.
// The whole game runs as one async function (run loop) that pauses on player
// prompts; the server resolves prompts from socket messages.
import { cards, buildDeck, shuffle, COLORS } from "../gamedata.js";
import { effects, hopeGrant, graceGrant } from "./effects.js";

let IID = 0;

export class Game {
  constructor({ playerCount, deckMode, onUpdate, onLog, onGameOver }) {
    this.playerCount = playerCount;
    this.deckMode = deckMode;
    this.onUpdate = onUpdate || (() => {});
    this.onLog = onLog || (() => {});
    this.onGameOver = onGameOver || (() => {});

    this.players = []; // {seat, name, hand:[iid], roundWins, hurtFeelings, nextTurnPlays, gen: extra play grants for next turn}
    this.deck = []; // iid[], index 0 = top
    this.discard = []; // iid[]
    this.insts = new Map(); // iid -> {iid, num}
    this.mood = new Map(); // iid -> mood state while in play

    this.round = 0;
    this.playCounter = 0;
    this.phase = "lobby"; // lobby | playing | scoring | over
    this.activeSeat = null;
    this.firstSeat = 0;
    this.roundPlays = []; // {seat, n, iid} this round
    this.discardedThisRound = false;
    this.doubtColors = null; // {colors:[..], round} restriction active during `round`
    this.afterScoringQueue = []; // {iid, seat, n (playCounter), kind}
    this.turn = null; // per-turn state
    this.pendingPrompt = null; // {seat, spec, resolve}
    this.lastWinnerSeat = null;
    this.nextFirstOverride = null; // set by Awe
    this.corruptionDouble = false;
    this.gameWinner = null;
    this.logLines = [];
  }

  // ---------- setup ----------

  addPlayer(name) {
    const seat = this.players.length;
    this.players.push({
      seat,
      name,
      hand: [],
      moods: [], // iid[] in play order
      roundWins: 0,
      hurtFeelings: false,
      nextTurnPlays: 0,
    });
    return seat;
  }

  start() {
    const nums = buildDeck(this.deckMode);
    this.deck = nums.map((num) => {
      const iid = ++IID;
      this.insts.set(iid, { iid, num });
      return iid;
    });
    const bottom = this.def(this.deck[this.deck.length - 1]);
    this.firstSeat = Math.floor(Math.random() * this.players.length);
    this.log(
      `The bottom card of the deck is ${bottom.name}. Whoever most recently felt ${bottom.name.toLowerCase()} would choose the first player — we chose ${this.players[this.firstSeat].name} at random.`
    );
    for (const p of this.players) this.drawCards(p.seat, 5, true);
    this.phase = "playing";
    this.run().catch((e) => {
      console.error("Game crashed:", e);
      this.log(`⚠ Internal error: ${e.message}`);
      this.push();
    });
  }

  // ---------- helpers ----------

  inst(iid) {
    return this.insts.get(iid);
  }

  /** Effective printed definition (copies resolve to the copied card). */
  def(iid) {
    const m = this.mood.get(iid);
    if (m && m.copyOf != null) return cards[m.copyOf];
    return cards[this.inst(iid).num];
  }

  /** Effective card number for rules purposes. */
  effNum(iid) {
    const m = this.mood.get(iid);
    return m && m.copyOf != null ? m.copyOf : this.inst(iid).num;
  }

  player(seat) {
    return this.players[seat];
  }

  opponentsOf(seat) {
    return this.players.filter((p) => p.seat !== seat).map((p) => p.seat);
  }

  inPlay(iid) {
    return this.mood.has(iid);
  }

  allMoods() {
    // global play order
    return this.players
      .flatMap((p) => p.moods)
      .sort((a, b) => this.mood.get(a).playedN - this.mood.get(b).playedN);
  }

  moodsOf(seat) {
    return [...this.player(seat).moods];
  }

  controllerOf(iid) {
    return this.mood.get(iid)?.controller ?? null;
  }

  /** Color(s) of a card. Moods in play are subject to Imagination (#42). */
  colorOf(iid) {
    if (this.inPlay(iid)) {
      const imag = this.latestMoodOfNum(42);
      if (imag != null) return this.mood.get(imag).chosenColor;
    }
    return this.def(iid).color;
  }

  /** Latest-played mood in play whose effective number matches (Honor/Imagination "last wins"). */
  latestMoodOfNum(num) {
    let best = null;
    for (const iid of this.allMoods()) {
      if (this.effNum(iid) === num) best = iid; // allMoods is in play order
    }
    return best;
  }

  moodsOfNum(num) {
    return this.allMoods().filter((iid) => this.effNum(iid) === num);
  }

  countMoodsWithColors(colorList) {
    return this.allMoods().filter((iid) => colorList.includes(this.colorOf(iid))).length;
  }

  isSuppressed(iid) {
    const m = this.mood.get(iid);
    if (!m) return false;
    m.suppressions = m.suppressions.filter(
      (s) => s.type === "round" || (s.source != null && this.inPlay(s.source))
    );
    return m.suppressions.length > 0;
  }

  suppress(iid, { source = null, type = "source" } = {}) {
    const m = this.mood.get(iid);
    if (!m) return;
    m.suppressions.push({ source, type });
    this.log(`${this.nameOf(iid)} is suppressed.`);
  }

  /** Current value of a mood in play. */
  value(iid) {
    if (!this.inPlay(iid)) return this.def(iid).primary;
    if (this.isSuppressed(iid)) return 0;
    const def = this.def(iid);
    const m = this.mood.get(iid);

    // Encouragement (#11) / Idealism (#16): use the higher printed dice total.
    if (def.secondary != null && this.higherDiceApplies(iid)) {
      return Math.max(def.primary, def.secondary);
    }

    let v;
    const fx = effects[def.num];
    if (m.valueSet != null) v = m.valueSet;
    else if (fx?.value) v = fx.value(this, iid);
    else v = def.primary;
    if (fx?.bonus) v += fx.bonus(this, iid);
    return Math.max(0, v);
  }

  higherDiceApplies(iid) {
    const ctl = this.controllerOf(iid);
    for (const e of this.moodsOfNum(11)) {
      if (this.mood.get(e).chosenMood === iid) return true;
    }
    for (const ide of this.moodsOfNum(16)) {
      if (this.controllerOf(ide) === ctl) return true;
    }
    return false;
  }

  nameOf(iid) {
    return this.def(iid).name;
  }

  log(msg) {
    this.logLines.push(msg);
    if (this.logLines.length > 200) this.logLines.shift();
    this.onLog(msg);
  }

  push() {
    this.onUpdate();
  }

  // ---------- zone movement ----------

  removeFromZones(iid) {
    const d = this.deck.indexOf(iid);
    if (d >= 0) this.deck.splice(d, 1);
    const x = this.discard.indexOf(iid);
    if (x >= 0) this.discard.splice(x, 1);
    for (const p of this.players) {
      const h = p.hand.indexOf(iid);
      if (h >= 0) p.hand.splice(h, 1);
      const mi = p.moods.indexOf(iid);
      if (mi >= 0) p.moods.splice(mi, 1);
    }
  }

  leavePlayCleanup(iid) {
    const m = this.mood.get(iid);
    if (!m) return;
    const en = this.effNum(iid);
    this.mood.delete(iid);
    effects[en]?.onLeave?.(this, iid, m);
  }

  toDiscard(iid, { silent = false } = {}) {
    const wasPlay = this.inPlay(iid);
    this.removeFromZones(iid);
    this.leavePlayCleanup(iid);
    this.discard.push(iid);
    this.discardedThisRound = true;
    if (!silent) this.log(`${cards[this.inst(iid).num].name} is put into the discard pile.`);
    this.push();
  }

  toHand(iid, seat, { silent = false } = {}) {
    this.removeFromZones(iid);
    this.leavePlayCleanup(iid);
    this.player(seat).hand.push(iid);
    if (!silent) this.log(`${cards[this.inst(iid).num].name} goes to ${this.player(seat).name}'s hand.`);
    this.push();
  }

  toDeckBottom(iid, { silent = false } = {}) {
    this.removeFromZones(iid);
    this.leavePlayCleanup(iid);
    this.deck.push(iid);
    if (!silent) this.log(`${cards[this.inst(iid).num].name} is put on the bottom of the deck.`);
    this.push();
  }

  drawCards(seat, n, silent = false) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!this.deck.length) break;
      const iid = this.deck.shift();
      this.player(seat).hand.push(iid);
      drawn++;
    }
    if (!silent && drawn) this.log(`${this.player(seat).name} draws ${drawn} card${drawn > 1 ? "s" : ""}.`);
    if (!silent && drawn < n) this.log(`The deck is empty.`);
    this.push();
    return drawn;
  }

  discardFromHand(seat, iid) {
    this.toDiscard(iid, { silent: true });
    this.log(`${this.player(seat).name} discards ${cards[this.inst(iid).num].name}.`);
  }

  /** Move a mood in play to another player's control (keeps all state). */
  giveMood(iid, toSeat, { silent = false } = {}) {
    const m = this.mood.get(iid);
    if (!m) return;
    const from = this.player(m.controller);
    const idx = from.moods.indexOf(iid);
    if (idx >= 0) from.moods.splice(idx, 1);
    m.controller = toSeat;
    this.player(toSeat).moods.push(iid);
    if (!silent) this.log(`${this.nameOf(iid)} now belongs to ${this.player(toSeat).name}.`);
    this.push();
  }

  // ---------- prompts ----------

  prompt(seat, spec) {
    this.push();
    return new Promise((resolve) => {
      this.pendingPrompt = { seat, spec, resolve };
      this.push();
    });
  }

  /** Called by the server when the prompted player responds. */
  answerPrompt(seat, answer) {
    const p = this.pendingPrompt;
    if (!p || p.seat !== seat) return false;
    if (!this.validateAnswer(p.spec, answer)) return false;
    this.pendingPrompt = null;
    p.resolve(answer);
    return true;
  }

  validateAnswer(spec, a) {
    if (!a || typeof a !== "object") return false;
    switch (spec.type) {
      case "turn": {
        if (a.action === "pass") return true;
        if (a.action !== "play") return false;
        return spec.plays.some((pl) => pl.iid === a.iid && (a.grantId == null || pl.grants.includes(a.grantId)));
      }
      case "confirm":
        return typeof a.yes === "boolean";
      case "chooseMoods": {
        if (!Array.isArray(a.iids)) return false;
        if (a.iids.length < spec.min || a.iids.length > spec.max) return false;
        if (new Set(a.iids).size !== a.iids.length) return false;
        if (!a.iids.every((i) => spec.eligible.includes(i))) return false;
        if (spec.maxTotal != null) {
          const total = a.iids.reduce((s, i) => s + this.value(i), 0);
          if (total > spec.maxTotal) return false;
        }
        return true;
      }
      case "chooseCards": {
        if (!Array.isArray(a.iids)) return false;
        if (a.iids.length < spec.min || a.iids.length > spec.max) return false;
        if (new Set(a.iids).size !== a.iids.length) return false;
        return a.iids.every((i) => spec.eligible.includes(i));
      }
      case "choosePlayers": {
        if (!Array.isArray(a.seats)) return false;
        if (a.seats.length < spec.min || a.seats.length > spec.max) return false;
        if (new Set(a.seats).size !== a.seats.length) return false;
        return a.seats.every((s) => spec.eligible.includes(s));
      }
      case "chooseColor":
        return spec.colors.includes(a.color);
      case "chooseNumber":
        return Number.isInteger(a.number) && a.number >= spec.min && a.number <= spec.max;
      case "chooseOption":
        return spec.options.some((o) => o.id === a.id);
      default:
        return false;
    }
  }

  // Convenience wrappers -------------------------------------------------

  async confirm(seat, text) {
    const a = await this.prompt(seat, { type: "confirm", text });
    return a.yes;
  }

  /** Choose moods in play. Returns array of iids ([] allowed if min 0 / optional). */
  async chooseMoods(seat, { eligible, min = 1, max = 1, text, maxTotal = null }) {
    eligible = eligible.filter((iid) => this.inPlay(iid));
    if (!eligible.length || max === 0) return [];
    min = Math.min(min, eligible.length);
    max = Math.min(max, eligible.length);
    const a = await this.prompt(seat, { type: "chooseMoods", eligible, min, max, text, maxTotal });
    return a.iids;
  }

  async chooseMood(seat, { eligible, optional = false, text }) {
    const r = await this.chooseMoods(seat, { eligible, min: optional ? 0 : 1, max: 1, text });
    return r[0] ?? null;
  }

  /** Choose cards from a non-play zone (hand/discard). `eligible` are iids; `zone` is a UI hint. */
  async chooseCards(seat, { eligible, min = 1, max = 1, zone, text, ofSeat = null }) {
    if (!eligible.length || max === 0) return [];
    min = Math.min(min, eligible.length);
    max = Math.min(max, eligible.length);
    const a = await this.prompt(seat, { type: "chooseCards", eligible, min, max, zone, text, ofSeat });
    return a.iids;
  }

  async choosePlayers(seat, { eligible, min = 1, max = 1, text }) {
    if (!eligible.length || max === 0) return [];
    min = Math.min(min, eligible.length);
    const a = await this.prompt(seat, { type: "choosePlayers", eligible, min, max, text });
    return a.seats;
  }

  async choosePlayer(seat, { eligible, optional = false, text }) {
    const r = await this.choosePlayers(seat, { eligible, min: optional ? 0 : 1, max: 1, text });
    return r[0] ?? null;
  }

  async chooseColor(seat, text, colors = COLORS) {
    const a = await this.prompt(seat, { type: "chooseColor", colors, text });
    return a.color;
  }

  async chooseNumber(seat, text, min = 0, max = 12) {
    const a = await this.prompt(seat, { type: "chooseNumber", min, max, text });
    return a.number;
  }

  async chooseOption(seat, text, options) {
    const a = await this.prompt(seat, { type: "chooseOption", text, options });
    return a.id;
  }

  // ---------- play grants ----------

  grantExtraPlay(seat, grant) {
    if (this.turn && this.turn.seat === seat) {
      grant.id = ++this.turn.grantSeq;
      this.turn.grants.push(grant);
    }
  }

  // ---------- main loop ----------

  async run() {
    while (this.phase !== "over") {
      this.round++;
      await this.playRound();
    }
  }

  async playRound() {
    this.roundPlays = [];
    this.discardedThisRound = false;
    this.aweSeat = null;
    this.corruptionDouble = false;
    this.afterScoringQueue = [];
    // first player: Honor (#15, latest) > Awe override > last round winner > previous first
    const honor = this.latestMoodOfNum(15);
    if (honor != null && this.mood.get(honor).chosenPlayer != null) {
      this.firstSeat = this.mood.get(honor).chosenPlayer;
    } else if (this.nextFirstOverride != null) {
      this.firstSeat = this.nextFirstOverride;
    } else if (this.lastWinnerSeat != null) {
      this.firstSeat = this.lastWinnerSeat;
    }
    this.nextFirstOverride = null;
    this.log(`— Round ${this.round} begins. ${this.player(this.firstSeat).name} goes first. —`);

    for (let i = 0; i < this.players.length; i++) {
      const seat = (this.firstSeat + i) % this.players.length;
      await this.takeTurn(seat);
      if (this.phase === "over") return;
    }
    await this.scoreRound();
    // expire this round's Doubt restriction
    if (this.doubtColors && this.doubtColors.round <= this.round) this.doubtColors = null;
    // end-of-round suppressions expire
    for (const [, m] of this.mood) {
      m.suppressions = m.suppressions.filter((s) => s.type !== "round");
    }
    // "played this round" flags reset naturally via playedRound comparison
    this.push();
  }

  async takeTurn(seat) {
    const p = this.player(seat);
    this.activeSeat = seat;
    this.turn = {
      seat,
      basePlays: 1,
      grants: [],
      grantSeq: 0,
      playedThisTurn: [],
    };
    // start-of-turn grants
    if (p.hurtFeelings) {
      p.hurtFeelings = false;
      this.grantExtraPlay(seat, { label: "Hurt Feelings" });
      this.log(`${p.name} may play an additional mood this turn (Hurt Feelings).`);
    }
    for (let i = 0; i < p.nextTurnPlays; i++) this.grantExtraPlay(seat, { label: "carried over" });
    p.nextTurnPlays = 0;
    // Stubbornness (#102): checked at start of turn; grant persists even if it leaves play
    for (const st of this.moodsOfNum(102)) {
      if (this.controllerOf(st) !== seat) continue;
      const someoneHasMore = this.players.some((q) => q.seat !== seat && q.moods.length > p.moods.length);
      if (someoneHasMore) this.grantExtraPlay(seat, { label: cards[102].name });
    }
    // Hope (#124) and Grace (#121): extra play each of your turns while in play
    for (const h of this.moodsOfNum(124)) {
      if (this.controllerOf(h) === seat) this.grantExtraPlay(seat, hopeGrant(h, seat));
    }
    for (const gr of this.moodsOfNum(121)) {
      if (this.controllerOf(gr) === seat) this.grantExtraPlay(seat, graceGrant(gr, seat));
    }
    this.push();

    let passed = false;
    let playedAnything = false;
    while (!passed) {
      const plays = this.legalPlays(seat);
      if (!plays.length) {
        if (!playedAnything) this.log(`${p.name} has no legal plays and passes.`);
        break;
      }
      const a = await this.prompt(seat, {
        type: "turn",
        plays,
        canPass: true,
        playedAnything,
      });
      if (a.action === "pass") {
        if (!playedAnything) this.log(`${p.name} passes.`);
        passed = true;
        break;
      }
      await this.playCard(seat, a.iid, a.grantId ?? null);
      playedAnything = true;
      if (this.phase === "over") return;
    }
    this.turn = null;
    this.activeSeat = null;
  }

  /** All legal plays for the active player right now: [{iid, zone, grants:[grantId|null...]}] */
  legalPlays(seat) {
    const t = this.turn;
    if (!t || t.seat !== seat) return [];
    const p = this.player(seat);
    const out = [];

    const slots = []; // {grantId|null, fromZone|null, filter|null, available}
    if (t.basePlays > 0) slots.push({ grantId: null });
    for (const g of t.grants) {
      if (g.used && !g.multi) continue;
      if (g.available && !g.available(this)) continue;
      slots.push({ grantId: g.id, fromZone: g.fromZone, filter: g.filter });
    }
    if (!slots.length) return [];

    // candidate cards: hand always; discard if Melancholy (#69) in play under this
    // player's control, or via discard-restricted grants
    const melancholy = this.moodsOfNum(69).some((iid) => this.controllerOf(iid) === seat);
    const candidates = [
      ...p.hand.map((iid) => ({ iid, zone: "hand" })),
      ...this.discard.map((iid) => ({ iid, zone: "discard" })),
    ];

    for (const c of candidates) {
      // Doubt (#36): can't play moods sharing a color with the revealed cards (printed color)
      if (this.doubtColors && this.doubtColors.round === this.round) {
        if (this.doubtColors.colors.includes(cards[this.inst(c.iid).num].color)) continue;
      }
      // cost payable?
      const fx = effects[this.inst(c.iid).num];
      if (fx?.canPay && !fx.canPay(this, seat, c.iid)) continue;
      if (this.inst(c.iid).num === 32) {
        // Creativity is always playable (copying is optional)
      }
      const grants = [];
      for (const s of slots) {
        // zone access: base play & generic grants reach hand (+discard if Melancholy);
        // discard-grants reach only discard
        if (s.fromZone === "discard" && c.zone !== "discard") continue;
        if (!s.fromZone && c.zone === "discard" && !melancholy) continue;
        if (s.filter && !s.filter(this, c.iid)) continue;
        grants.push(s.grantId);
      }
      if (grants.length) out.push({ iid: c.iid, zone: c.zone, grants });
    }
    return out;
  }

  async playCard(seat, iid, grantId) {
    const t = this.turn;
    const plays = this.legalPlays(seat);
    const play = plays.find((pl) => pl.iid === iid);
    if (!play) return;

    // pick the slot: explicit grantId, else prefer base play, else ask if grants
    // differ in riders, else first
    let chosenGrant = null;
    if (grantId != null && play.grants.includes(grantId)) {
      chosenGrant = t.grants.find((g) => g.id === grantId);
    } else if (play.grants.includes(null)) {
      chosenGrant = null;
    } else {
      const gs = play.grants.map((id) => t.grants.find((g) => g.id === id));
      if (gs.length > 1 && gs.some((g) => g.rider)) {
        const id = await this.chooseOption(
          seat,
          `Which extra play do you use for ${cards[this.inst(iid).num].name}?`,
          gs.map((g) => ({ id: String(g.id), label: g.label }))
        );
        chosenGrant = gs.find((g) => String(g.id) === id);
      } else {
        chosenGrant = gs[0];
      }
    }

    const def = cards[this.inst(iid).num];
    const p = this.player(seat);

    // Creativity (#32): choose what to copy before paying costs
    let copyOf = null;
    if (def.num === 32) {
      const eligible = this.allMoods().filter((m) => {
        const en = this.effNum(m);
        if (en === 32) return false; // copying a copy resolves to its target; raw Creativity in play is only possible uncopied
        const fx = effects[en];
        return !fx?.canPay || fx.canPay(this, seat, iid);
      });
      const target = await this.chooseMood(seat, {
        eligible,
        optional: true,
        text: "Play Creativity as a copy of a mood? (Skip to play it plain.)",
      });
      if (target != null) copyOf = this.effNum(target);
    }

    // remove from zone (stage), pay costs, then enter play
    this.removeFromZones(iid);
    this.staging = iid;
    const effNum = copyOf ?? def.num;
    const fx = effects[effNum];
    const ms = {
      controller: seat,
      playedN: ++this.playCounter,
      playedRound: this.round,
      valueSet: null,
      suppressions: [],
      copyOf,
      chosenColor: null,
      chosenPlayer: null,
      chosenMood: null,
      taken: [], // [{iid, fromSeat, returnWhen:'leavesPlay'|'afterScoring'}]
    };

    // pay costs while the card is staged (it is not yet a mood, so cost
    // helpers like "put one of your moods..." can't touch it)
    let costCtx = null;
    if (fx?.pay) costCtx = await fx.pay(this, seat, iid);

    // enter play
    this.staging = null;
    this.mood.set(iid, ms);
    p.moods.push(iid);
    if (chosenGrant && !chosenGrant.multi) chosenGrant.used = true;
    if (!chosenGrant) t.basePlays--;
    t.playedThisTurn.push(iid);
    this.roundPlays.push({ seat, n: ms.playedN, iid });
    const copyNote = copyOf ? ` (as a copy of ${cards[copyOf].name})` : "";
    this.log(`${p.name} plays ${def.name}${copyNote}.`);
    this.push();

    // riders from the grant used (Gluttony #93 / Insecurity #45)
    if (chosenGrant?.rider === "gluttony") {
      this.afterScoringQueue.push({ kind: "gluttonyRider", iid, seat, n: ms.playedN });
    }
    if (chosenGrant?.rider === "insecurity") {
      this.afterScoringQueue.push({ kind: "insecurityRider", iid, seat: chosenGrant.riderSeat, n: ms.playedN });
    }

    // after-play effect
    if (fx?.afterPlay) {
      await fx.afterPlay(this, iid, seat, costCtx);
      this.push();
    }

    // triggers on the controller's other moods (Scorn #24, Validation #26, Duplicity #37)
    if (this.inPlay(iid)) {
      for (const other of this.allMoods()) {
        if (other === iid) continue;
        if (this.controllerOf(other) !== seat) continue;
        const ofx = effects[this.effNum(other)];
        if (ofx?.onControllerPlayed) {
          await ofx.onControllerPlayed(this, other, iid, seat);
          this.push();
        }
      }
    }
  }

  /** Re-run a mood's after-play effect (Duplicity). */
  async repeatAfterPlay(iid, seat) {
    const fx = effects[this.effNum(iid)];
    if (fx?.afterPlay) await fx.afterPlay(this, iid, seat, null);
  }

  // ---------- scoring ----------

  async scoreRound() {
    this.phase = "scoring";
    this.push();

    if (this.aweSeat != null) {
      this.log(`There is no scoring this round (Awe).`);
      const pick = await this.choosePlayer(this.aweSeat, {
        eligible: this.players.map((p) => p.seat),
        text: "Choose who goes first next round.",
      });
      this.nextFirstOverride = pick;
      this.lastWinnerSeat = null;
      this.phase = "playing";
      return;
    }

    // base scores + extra scorings
    const scores = {};
    for (const p of this.players) {
      let s = 0;
      for (const m of p.moods) s += this.value(m);
      scores[p.seat] = s;
    }
    // mandatory extras: Exhilaration (#89), Bliss (#108)
    for (const iid of this.allMoods()) {
      const seat = this.controllerOf(iid);
      const en = this.effNum(iid);
      if (en === 89) {
        let extra = 0;
        for (const m of this.moodsOf(seat)) extra += this.value(m);
        scores[seat] += extra;
        this.log(`${this.player(seat).name} scores their moods an extra time (+${extra}).`);
      } else if (en === 108) {
        const col = this.mood.get(iid).chosenColor;
        let extra = 0;
        for (const m of this.moodsOf(seat)) {
          if (this.colorOf(m) === col) extra += 2 * this.value(m);
        }
        if (extra) {
          scores[seat] += extra;
          this.log(`${this.player(seat).name}'s ${col.toLowerCase()} moods score two extra times (+${extra}).`);
        }
      }
    }
    // optional extras: Enthusiasm (#116) own mood, Passion (#97) opponent mood
    for (const iid of this.allMoods()) {
      const seat = this.controllerOf(iid);
      const en = this.effNum(iid);
      if (en === 116) {
        const pick = await this.chooseMood(seat, {
          eligible: this.moodsOf(seat),
          optional: true,
          text: "Enthusiasm: score one of your moods an extra time?",
        });
        if (pick != null) {
          scores[seat] += this.value(pick);
          this.log(`${this.player(seat).name} scores ${this.nameOf(pick)} an extra time (+${this.value(pick)}).`);
        }
      } else if (en === 97) {
        const elig = this.opponentsOf(seat).flatMap((s) => this.moodsOf(s));
        const pick = await this.chooseMood(seat, {
          eligible: elig,
          optional: true,
          text: "Passion: score one of your opponents' moods as though it were yours?",
        });
        if (pick != null) {
          scores[seat] += this.value(pick);
          this.log(`${this.player(seat).name} scores ${this.nameOf(pick)} as their own (+${this.value(pick)}).`);
        }
      }
    }

    for (const p of this.players) this.log(`${p.name} scores ${scores[p.seat]}.`);

    // after-scoring effects, in the order played; same player may reorder.
    // Sneakiness swaps happen here too and can change the winner, so the winner
    // is determined lazily by a helper the effects can consult.
    // Effects resolve in the order they were played; when one player owns
    // several pending effects, that player chooses which of theirs goes next.
    const queue = [...this.afterScoringQueue].sort((a, b) => a.n - b.n);
    const winnerNow = () => this.decideWinner(scores);
    while (queue.length) {
      let item = queue[0];
      const mine = queue.filter((q) => q.seat === item.seat);
      if (mine.length > 1) {
        const id = await this.chooseOption(
          item.seat,
          "Choose which 'after scoring' effect happens next:",
          mine.map((q) => ({ id: String(queue.indexOf(q)), label: this.afterScoringLabel(q) }))
        );
        item = queue[Number(id)];
      }
      queue.splice(queue.indexOf(item), 1);
      await this.resolveAfterScoring(item, scores, winnerNow);
    }

    const winner = this.decideWinner(scores);
    const wins = this.corruptionDouble ? 2 : 1;
    this.player(winner).roundWins += wins;
    this.lastWinnerSeat = winner;
    this.log(
      `${this.player(winner).name} wins round ${this.round}${wins > 1 ? " (counts as two wins — Corruption)" : ""}! (${this.players.map((p) => `${p.name}: ${p.roundWins}`).join(", ")})`
    );

    if (this.player(winner).roundWins >= 3) {
      this.phase = "over";
      this.gameWinner = winner;
      this.log(`🏆 ${this.player(winner).name} wins the game!`);
      this.push();
      this.onGameOver(winner);
      return;
    }

    // losers draw
    for (let i = 0; i < this.players.length; i++) {
      const seat = (this.firstSeat + i) % this.players.length;
      if (seat !== winner) this.drawCards(seat, 1);
    }

    // Hurt Feelings (3+ players): lowest score; tie -> latest play this round
    if (this.players.length >= 3) {
      const low = Math.min(...this.players.map((p) => scores[p.seat]));
      const tied = this.players.filter((p) => scores[p.seat] === low).map((p) => p.seat);
      let hf = tied[0];
      if (tied.length > 1) {
        let best = -1;
        for (const s of tied) {
          const latest = Math.max(-1, ...this.roundPlays.filter((rp) => rp.seat === s).map((rp) => rp.n));
          if (latest > best) {
            best = latest;
            hf = s;
          }
        }
      }
      this.player(hf).hurtFeelings = true;
      this.log(`${this.player(hf).name} gets Hurt Feelings (may play an extra mood next turn).`);
    }

    this.phase = "playing";
    this.push();
  }

  decideWinner(scores) {
    let best = Math.max(...this.players.map((p) => scores[p.seat]));
    const tied = this.players.filter((p) => scores[p.seat] === best).map((p) => p.seat);
    if (tied.length === 1) return tied[0];
    // earliest play this round wins; players with no play rank last,
    // falling back to turn order from this round's first player
    let winner = null;
    let bestN = Infinity;
    for (const s of tied) {
      const plays = this.roundPlays.filter((rp) => rp.seat === s);
      const n = plays.length ? Math.min(...plays.map((rp) => rp.n)) : Infinity;
      if (n < bestN) {
        bestN = n;
        winner = s;
      }
    }
    if (winner != null) return winner;
    for (let i = 0; i < this.players.length; i++) {
      const s = (this.firstSeat + i) % this.players.length;
      if (tied.includes(s)) return s;
    }
    return tied[0];
  }

  afterScoringLabel(q) {
    switch (q.kind) {
      case "sneakiness":
        return "Sneakiness (swap scores)";
      case "bashfulness":
        return "Bashfulness (bottom of deck if you won)";
      case "betrayal":
        return "Betrayal (mood returns to you)";
      case "recklessness":
        return "Recklessness (bottom of deck, return taken mood)";
      case "gluttonyRider":
        return `Gluttony (discard ${this.inPlay(q.iid) ? this.nameOf(q.iid) : "extra mood"})`;
      case "insecurityRider":
        return `Insecurity (return ${this.inPlay(q.iid) ? this.nameOf(q.iid) : "extra mood"} to hand)`;
      default:
        return q.kind;
    }
  }

  async resolveAfterScoring(item, scores, winnerNow) {
    switch (item.kind) {
      case "sneakiness": {
        const a = scores[item.seat];
        scores[item.seat] = scores[item.target];
        scores[item.target] = a;
        this.log(
          `Sneakiness: ${this.player(item.seat).name} swaps scores with ${this.player(item.target).name}.`
        );
        break;
      }
      case "bashfulness": {
        if (!this.inPlay(item.iid)) break;
        if (winnerNow() === this.controllerOf(item.iid)) {
          const seat = this.controllerOf(item.iid);
          this.toDeckBottom(item.iid);
          this.drawCards(seat, 1);
        }
        break;
      }
      case "betrayal": {
        if (this.inPlay(item.target)) this.giveMood(item.target, item.seat);
        break;
      }
      case "recklessness": {
        // return the taken mood (only if the Recklessness player still has it)
        if (item.takenIid != null && this.inPlay(item.takenIid) && this.controllerOf(item.takenIid) === item.seat) {
          this.giveMood(item.takenIid, item.fromSeat);
        }
        // whoever has Recklessness bottom-decks it and draws
        if (this.inPlay(item.iid)) {
          const holder = this.controllerOf(item.iid);
          this.toDeckBottom(item.iid);
          this.drawCards(holder, 1);
        }
        break;
      }
      case "gluttonyRider": {
        if (this.inPlay(item.iid)) this.toDiscard(item.iid);
        break;
      }
      case "insecurityRider": {
        if (this.inPlay(item.iid)) this.toHand(item.iid, item.seat);
        break;
      }
    }
    this.push();
  }

  // ---------- client state ----------

  /** Redacted state for one seat. */
  stateFor(seat) {
    const me = this.player(seat);
    const cardPub = (iid) => {
      const printed = cards[this.inst(iid).num];
      const m = this.mood.get(iid);
      return {
        iid,
        num: printed.num,
        name: printed.name,
        image: printed.image,
        color: printed.color,
        rarity: printed.rarity,
        primary: printed.primary,
        secondary: printed.secondary,
        effect: printed.effect,
        bang: printed.bang,
        ...(m
          ? {
              copyOf: m.copyOf,
              copyName: m.copyOf ? cards[m.copyOf].name : null,
              copyImage: m.copyOf ? cards[m.copyOf].image : null,
              copyEffect: m.copyOf ? cards[m.copyOf].effect : null,
              value: this.value(iid),
              suppressed: this.isSuppressed(iid),
              effColor: this.colorOf(iid),
              chosenColor: m.chosenColor,
              chosenPlayer: m.chosenPlayer,
              playedRound: m.playedRound,
            }
          : {}),
      };
    };
    const livePrompt =
      this.pendingPrompt && this.pendingPrompt.seat === seat
        ? this.serializePrompt(this.pendingPrompt.spec)
        : null;
    return {
      seat,
      phase: this.phase,
      round: this.round,
      activeSeat: this.activeSeat,
      firstSeat: this.firstSeat,
      deckCount: this.deck.length,
      discard: this.discard.map(cardPub),
      doubt: this.doubtColors && this.doubtColors.round === this.round ? this.doubtColors.colors : null,
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        roundWins: p.roundWins,
        handCount: p.hand.length,
        hurtFeelings: p.hurtFeelings,
        score: p.moods.reduce((s, m) => s + this.value(m), 0),
        moods: p.moods.map(cardPub),
      })),
      hand: me.hand.map(cardPub),
      prompt: livePrompt,
      waitingOn: this.pendingPrompt ? this.pendingPrompt.seat : null,
      log: this.logLines.slice(-100),
      gameWinner: this.gameWinner,
    };
  }

  serializePrompt(spec) {
    const s = { ...spec };
    if (spec.type === "turn") {
      s.plays = spec.plays.map((pl) => ({
        iid: pl.iid,
        zone: pl.zone,
        grants: pl.grants.map((id) =>
          id == null ? { id: null, label: "your play" } : { id, label: this.turn.grants.find((g) => g.id === id)?.label ?? "extra play" }
        ),
      }));
    }
    // strip functions
    delete s.filter;
    return JSON.parse(JSON.stringify(s));
  }
}
