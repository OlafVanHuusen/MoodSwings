// Headless fuzz for the match layer: drafts, deck building, sideboards, Bo3.
import test from "node:test";
import assert from "node:assert";
import { Match, MODES, deckProblem } from "../server/match.js";
import { buildDeck, POOL, shuffle } from "../server/gamedata.js";

function randomGameAnswer(spec, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  switch (spec.type) {
    case "turn": {
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
      throw new Error(`Unknown game prompt ${spec.type}`);
  }
}

function randomMatchAnswer(spec, rng) {
  switch (spec.type) {
    case "draftPick": {
      const ids = shuffle(spec.cards.map((c) => c.id)).slice(0, spec.pick);
      return { ids };
    }
    case "winston":
      return { take: !spec.canSkip || rng() < 0.4 };
    case "trim": {
      const minKeep = Math.max(spec.min, spec.maxRemove != null ? spec.pool.length - spec.maxRemove : 0);
      const keep = minKeep + Math.floor(rng() * (spec.pool.length - minKeep + 1));
      return { ids: shuffle(spec.pool.map((c) => c.id)).slice(0, keep) };
    }
    default:
      throw new Error(`Unknown match prompt ${spec.type}`);
  }
}

async function runMatch({ mode, deckLists = null, seed, maxSteps = 30000 }) {
  let s = seed;
  const rng = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const def = MODES[mode];
  const playerCount = def.players[0];
  const players = Array.from({ length: playerCount }, (_, i) => ({
    seat: i,
    name: `P${i + 1}`,
    deckCards: deckLists ? deckLists[i] : null,
  }));
  const m = new Match({ mode, playerCount, deckMode: "random45", players, onUpdate() {} });
  m.start();

  let steps = 0;
  let idle = 0;
  while (m.matchWinner == null) {
    assert.ok(++steps < maxSteps, "match did not finish (hang?)");
    await new Promise((r) => setImmediate(r));
    if (m.phase === "game" && m.game?.pendingPrompt) {
      idle = 0;
      const { seat, spec } = m.game.pendingPrompt;
      let ans = randomGameAnswer(spec, rng);
      let ok = m.answer(seat, ans);
      while (!ok && (spec.type === "chooseMoods" || spec.type === "chooseCards") && ans.iids.length > spec.min) {
        ans = { iids: ans.iids.slice(0, -1) };
        ok = m.answer(seat, ans);
      }
      assert.ok(ok, `game rejected generated answer for ${spec.type}`);
    } else if (m.pending.size) {
      idle = 0;
      const [seat, { spec }] = m.pending.entries().next().value;
      const ok = m.answer(seat, randomMatchAnswer(spec, rng));
      assert.ok(ok, `match rejected generated answer for ${spec.type}`);
    } else {
      assert.ok(++idle < 5000, `match idle in phase ${m.phase} (deadlock)`);
    }
  }
  return m;
}

const N = Number(process.env.FUZZ_N || 12);

test("deck format validation", () => {
  const deck45 = buildDeck("random45");
  assert.strictEqual(deckProblem("structure", deck45), null);
  assert.match(deckProblem("structure", deck45.slice(0, 44)), /at least 45/);
  const twelve = shuffle([...POOL]).slice(0, 12);
  assert.strictEqual(deckProblem("power", twelve), null);
  assert.match(deckProblem("power", [...twelve.slice(0, 11), twelve[0]]), /one copy/);
  assert.match(deckProblem("power", twelve.slice(0, 11)), /at least 12/);
  assert.strictEqual(deckProblem("classic", null), null);
});

test("match: structure duel completes", async () => {
  for (let seed = 1; seed <= Math.ceil(N / 4); seed++) {
    const m = await runMatch({
      mode: "structure",
      deckLists: [buildDeck("random45"), buildDeck("random45")],
      seed,
    });
    assert.ok([0, 1].includes(m.matchWinner));
    assert.strictEqual(m.gameNo, 1, "structure duel is a single game");
  }
});

test("match: quick draft drafts 16 each and plays best of three", async () => {
  for (let seed = 10; seed <= 10 + Math.ceil(N / 4); seed++) {
    const m = await runMatch({ mode: "quickdraft", seed });
    assert.strictEqual(m.pools[0].length, 16);
    assert.strictEqual(m.pools[1].length, 16);
    for (const d of m.decks) assert.ok(d.length >= 12 && d.length <= 16);
    assert.strictEqual(m.gameWins[m.matchWinner], 2, "winner has two game wins");
    // no card duplicated across the two pools (ids unique per draft)
    const ids = [...m.pools[0], ...m.pools[1]].map((c) => c.id);
    assert.strictEqual(new Set(ids).size, 32);
  }
});

test("match: winston draft distributes all 45 cards and plays best of three", async () => {
  for (let seed = 20; seed <= 20 + Math.ceil(N / 4); seed++) {
    const m = await runMatch({ mode: "winston", seed });
    if (m.gameNo === 0) {
      // someone drafted under 12 and auto-lost
      assert.ok(m.pools[1 - m.matchWinner].length < 12);
    } else {
      assert.strictEqual(m.pools[0].length + m.pools[1].length, 45);
      for (const d of m.decks) assert.ok(d.length >= 12);
      assert.strictEqual(m.gameWins[m.matchWinner], 2);
    }
  }
});

test("match: team modes complete", async () => {
  for (const mode of ["team-open", "team-closed"]) {
    for (let seed = 30; seed <= 30 + Math.ceil(N / 4); seed++) {
      const m = await runMatch({ mode, seed });
      assert.ok(m.game.gameWinnerTeam != null);
    }
  }
});
