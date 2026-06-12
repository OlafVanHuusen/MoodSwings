// Headless fuzz test: plays full games with random (but valid) answers to
// every prompt, across player counts and deck modes. Catches crashes, hangs,
// and invariant violations in the engine and all card effects.
import test from "node:test";
import assert from "node:assert";
import { Game } from "../server/engine/game.js";

function randomAnswer(spec, rng = Math.random) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  switch (spec.type) {
    case "turn": {
      // pass sometimes; otherwise play a random legal card
      if (!spec.plays.length || rng() < 0.15) return { action: "pass" };
      const pl = pick(spec.plays);
      return { action: "play", iid: pl.iid, grantId: pick(pl.grants) ?? null };
    }
    case "confirm":
      return { yes: rng() < 0.7 };
    case "chooseMoods":
    case "chooseCards": {
      const wantMax = spec.min + Math.floor(rng() * (spec.max - spec.min + 1));
      const pool = [...spec.eligible];
      const iids = [];
      while (iids.length < wantMax && pool.length) {
        iids.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      }
      return { iids };
    }
    case "choosePlayers": {
      const wantMax = spec.min + Math.floor(rng() * (spec.max - spec.min + 1));
      const pool = [...spec.eligible];
      const seats = [];
      while (seats.length < wantMax && pool.length) {
        seats.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      }
      return { seats };
    }
    case "chooseColor":
      return { color: pick(spec.colors) };
    case "chooseNumber":
      return { number: spec.min + Math.floor(rng() * (spec.max - spec.min + 1)) };
    case "chooseOption":
      return { id: pick(spec.options).id };
    default:
      throw new Error(`Unknown prompt type ${spec.type}`);
  }
}

function checkInvariants(g) {
  // every instance is in exactly one zone
  const seen = new Map();
  const note = (iid, zone) => {
    assert.ok(!seen.has(iid), `card ${iid} in two zones: ${seen.get(iid)} and ${zone}`);
    seen.set(iid, zone);
  };
  for (const iid of g.deck) note(iid, "deck");
  for (const iid of g.discard) note(iid, "discard");
  if (g.staging != null) note(g.staging, "staging");
  for (const p of g.players) {
    for (const iid of p.hand) note(iid, `hand${p.seat}`);
    for (const iid of p.moods) note(iid, `play${p.seat}`);
  }
  assert.strictEqual(seen.size, g.insts.size, "all cards accounted for");
  // mood map matches play zones
  for (const p of g.players) {
    for (const iid of p.moods) {
      assert.ok(g.mood.has(iid), `mood state missing for in-play card ${iid}`);
      assert.strictEqual(g.mood.get(iid).controller, p.seat, "controller mismatch");
    }
  }
  for (const iid of g.mood.keys()) {
    assert.ok(
      g.players.some((p) => p.moods.includes(iid)),
      `mood state for card not in play: ${iid}`
    );
  }
  // values are non-negative integers
  for (const p of g.players) {
    for (const iid of p.moods) {
      const v = g.value(iid);
      assert.ok(Number.isInteger(v) && v >= 0, `bad value ${v} for ${g.nameOf(iid)}`);
    }
  }
}

async function runGame({ players, deckMode, seed, maxPrompts = 8000 }) {
  // deterministic-ish rng
  let s = seed;
  const rng = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const g = new Game({ playerCount: players, deckMode, onUpdate() {}, onLog() {} });
  for (let i = 0; i < players; i++) g.addPlayer(`P${i + 1}`);

  let prompts = 0;
  let done = false;
  let crash = null;

  const finished = new Promise((resolve) => {
    g.onGameOver = () => {
      done = true;
      resolve();
    };
  });

  // wrap run loop error reporting
  const origLog = g.log.bind(g);
  g.log = (msg) => {
    if (String(msg).startsWith("⚠ Internal error")) crash = msg;
    origLog(msg);
  };

  g.start();

  let idleSpins = 0;
  while (!done) {
    if (crash) throw new Error(crash);
    if (!g.pendingPrompt) {
      await new Promise((r) => setImmediate(r));
      if (g.phase === "over") break;
      if (!g.pendingPrompt) {
        assert.ok(++idleSpins < 5000, "engine idle with no prompt and game not over (deadlock)");
        continue;
      }
    }
    idleSpins = 0;
    prompts++;
    assert.ok(prompts < maxPrompts, `game did not finish after ${maxPrompts} prompts (likely a hang/loop)`);
    const { seat, spec } = g.pendingPrompt;
    checkInvariants(g);
    let ans = randomAnswer(spec, rng);
    let ok = g.answerPrompt(seat, ans);
    // chooseMoods with a maxTotal cap (Anger): the fuzzer can't see values, so
    // shrink the selection until accepted
    while (!ok && (spec.type === "chooseMoods" || spec.type === "chooseCards") && ans.iids.length > spec.min) {
      ans = { iids: ans.iids.slice(0, ans.iids.length - 1) };
      ok = g.answerPrompt(seat, ans);
    }
    assert.ok(ok, `engine rejected its own generated answer for ${spec.type}: ${JSON.stringify(ans)}`);
    await new Promise((r) => setImmediate(r));
  }
  if (crash) throw new Error(crash);
  await finished;
  checkInvariants(g);
  assert.ok(g.gameWinner != null, "game ended with a winner");
  assert.ok(g.players[g.gameWinner].roundWins >= 3, "winner has 3+ round wins");
  return { rounds: g.round, prompts };
}

const N = Number(process.env.FUZZ_N || 12);

test("fuzz: 2-player random45 games complete", async () => {
  for (let seed = 1; seed <= N; seed++) {
    const r = await runGame({ players: 2, deckMode: "random45", seed });
    assert.ok(r.rounds >= 3);
  }
});

test("fuzz: 3-player full-deck games complete", async () => {
  for (let seed = 100; seed <= 100 + Math.ceil(N / 2); seed++) {
    await runGame({ players: 3, deckMode: "full", seed });
  }
});

test("fuzz: 4-player games complete", async () => {
  for (let seed = 200; seed <= 200 + Math.ceil(N / 2); seed++) {
    await runGame({ players: 4, deckMode: "random45", seed });
  }
});
