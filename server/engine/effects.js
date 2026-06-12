// Implementations of all 134 Mood Swings card effects, keyed by card number.
// Hooks available per card:
//   value(g, iid)            -> number   (conditional "while in play" value)
//   bonus(g, iid)            -> number   (additive "while in play" value increase)
//   canPay(g, seat, iid)     -> bool     ("To play this card" cost check; iid is the staged card)
//   pay(g, seat, iid)        -> ctx      (pay the cost; may prompt)
//   afterPlay(g, iid, seat, costCtx)     ("After playing this mood")
//   onControllerPlayed(g, iid, played, seat)  (controller played another mood)
//   onLeave(g, iid, moodState)           (mood left play)
import { cards, COLORS, shuffle } from "../gamedata.js";

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// "This mood's value is [secondary] if there are two or more X and/or Y moods."
const twoPlusColors = (a, b) => (g, iid) => {
  const def = g.def(iid);
  return g.countMoodsWithColors([a, b]) >= 2 ? def.secondary : def.primary;
};

const printedPrimary = (iid, g) => cards[g.inst(iid).num].primary;
const printedColor = (iid, g) => cards[g.inst(iid).num].color;

/** "Choose up to two players. For each chosen player, <do something to> one of
 *  their moods <matching filter>." The active player picks the players and moods. */
async function upToTwoPlayersMoods(g, seat, srcIid, { filter, act, what }) {
  const eligibleSeats = g.players
    .filter((p) => p.moods.some((m) => filter(g, m)))
    .map((p) => p.seat);
  const picks = await g.choosePlayers(seat, {
    eligible: eligibleSeats,
    min: 0,
    max: 2,
    text: `Choose up to two players (${what}).`,
  });
  for (const s of picks) {
    const elig = g.moodsOf(s).filter((m) => filter(g, m));
    const mood = await g.chooseMood(seat, {
      eligible: elig,
      text: `${g.player(s).name}: choose which mood (${what}).`,
    });
    if (mood != null) await act(mood, s);
  }
}

/** Most common effective color(s) among all moods in play. */
function mostCommonMoodColors(g) {
  const counts = {};
  for (const m of g.allMoods()) {
    const c = g.colorOf(m);
    counts[c] = (counts[c] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  if (!max) return [];
  return Object.keys(counts).filter((c) => counts[c] === max);
}

/** Discard a card from hand matching a filter; on success set this mood's value. */
const discardToSetValue = (handFilter, newValue, what) => async (g, iid, seat) => {
  const elig = g.player(seat).hand.filter((c) => handFilter(g, c));
  if (!elig.length) return;
  const picks = await g.chooseCards(seat, {
    eligible: elig,
    min: 0,
    max: 1,
    zone: "hand",
    text: `Discard ${what} to set ${g.nameOf(iid)}'s value to ${newValue}? (Skip to decline.)`,
  });
  if (picks.length) {
    g.discardFromHand(seat, picks[0]);
    g.mood.get(iid).valueSet = newValue;
    g.log(`${g.nameOf(iid)}'s value becomes ${newValue}.`);
  }
};

/** Cost: put N (or one-or-more) of your moods into a zone. */
const moodCost = ({ min, max, dest, what }) => ({
  canPay: (g, seat) => g.moodsOf(seat).length >= min,
  pay: async (g, seat) => {
    const picks = await g.chooseMoods(seat, {
      eligible: g.moodsOf(seat),
      min,
      max: max ?? min,
      text: `Cost: put ${what}.`,
    });
    for (const m of picks) {
      if (dest === "hand") g.toHand(m, g.controllerOf(m));
      else g.toDiscard(m);
    }
    return { paid: picks };
  },
});

export const effects = {
  // ===== WHITE =====

  1: {
    // Altruism
    afterPlay: async (g, iid, seat) => {
      if (!g.discard.length) return;
      g.mood.get(iid).valueSet = 7;
      g.log(`${g.nameOf(iid)}'s value becomes 7.`);
      const n = g.players.length;
      for (let i = 1; i <= n && g.discard.length; i++) {
        const s = (seat + i) % n;
        const card = rand(g.discard);
        g.toHand(card, s, { silent: true });
        g.log(`${g.player(s).name} takes a random card from the discard pile.`);
      }
      const rest = [...g.discard];
      shuffle(rest);
      for (const c of rest) g.toDeckBottom(c, { silent: true });
      if (rest.length) g.log(`The rest of the discard pile goes to the bottom of the deck.`);
    },
  },

  2: {
    // Benevolence: extra play if it doesn't share a color with any of your moods
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, {
        label: "Benevolence",
        filter: (gg, c) => !gg.moodsOf(seat).some((m) => gg.colorOf(m) === printedColor(c, gg)),
      });
    },
  },

  3: {
    // Charity
    afterPlay: async (g, iid, seat) => g.grantExtraPlay(seat, { label: "Charity" }),
  },

  4: {
    // Chivalry: secondary if you didn't go first this round
    value: (g, iid) => (g.controllerOf(iid) !== g.firstSeat ? g.def(iid).secondary : g.def(iid).primary),
  },

  5: {}, // Complacency (vanilla)

  6: {
    // Conviction: chosen mood goes to bottom of deck, its player draws
    afterPlay: async (g, iid, seat) => {
      const pick = await g.chooseMood(seat, {
        eligible: g.allMoods().filter((m) => m !== iid),
        text: "Choose a mood to put on the bottom of the deck (its player draws a card).",
      });
      if (pick == null) return;
      const owner = g.controllerOf(pick);
      g.toDeckBottom(pick);
      g.drawCards(owner, 1);
    },
  },

  7: {
    // Courage: up to two players, discard one of their moods with value 5+
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => gg.value(m) >= 5,
        act: async (m) => g.toDiscard(m),
        what: "discard a mood with value 5 or more",
      });
    },
  },

  8: { afterPlay: discardToSetValue((g, c) => [0, 1, 2, 3].includes(printedPrimary(c, g)), 5, "a card with 0-3 top right") }, // Dignity

  9: { value: twoPlusColors("Black", "Red") }, // Discipline

  10: {
    // Disillusionment: each player may choose a color; discard all other moods of those colors
    afterPlay: async (g, iid, seat) => {
      const n = g.players.length;
      const chosen = new Set();
      for (let i = 1; i <= n; i++) {
        const s = (seat + i) % n;
        const yes = await g.confirm(s, "Disillusionment: choose a color? (All other moods of chosen colors are discarded.)");
        if (yes) chosen.add(await g.chooseColor(s, "Choose a color."));
      }
      if (!chosen.size) return;
      const toGo = g.allMoods().filter((m) => m !== iid && chosen.has(g.colorOf(m)));
      for (const m of toGo) g.toDiscard(m);
    },
  },

  11: {
    // Encouragement: chosen mood uses its higher printed dice total (handled in Game.value)
    afterPlay: async (g, iid, seat) => {
      const elig = g.allMoods().filter((m) => g.def(m).secondary != null && m !== iid);
      const pick = await g.chooseMood(seat, {
        eligible: elig,
        optional: true,
        text: "Choose a mood with dice in its lower left corner (it uses the higher total).",
      });
      if (pick != null) {
        g.mood.get(iid).chosenMood = pick;
        g.log(`${g.nameOf(pick)} now uses its higher printed value.`);
      }
    },
  },

  12: {
    // Faith: discard green/blue card to suppress any mood while you have this
    afterPlay: async (g, iid, seat) => {
      const elig = g.player(seat).hand.filter((c) => ["Green", "Blue"].includes(printedColor(c, g)));
      const picks = await g.chooseCards(seat, {
        eligible: elig,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Discard a green or blue card to suppress a mood? (Skip to decline.)",
      });
      if (!picks.length) return;
      g.discardFromHand(seat, picks[0]);
      const target = await g.chooseMood(seat, {
        eligible: g.allMoods().filter((m) => m !== iid),
        text: "Choose a mood to suppress.",
      });
      if (target != null) g.suppress(target, { source: iid });
    },
  },

  13: {
    // Friendliness: extra play if printed value 0/2/4/6
    afterPlay: async (g, iid, seat) =>
      g.grantExtraPlay(seat, {
        label: "Friendliness",
        filter: (gg, c) => [0, 2, 4, 6].includes(printedPrimary(c, gg)),
      }),
  },

  14: {
    // Guilt: suppress a black/red mood, or all black and red moods
    afterPlay: async (g, iid, seat) => {
      const eligible = g.allMoods().filter((m) => m !== iid && ["Black", "Red"].includes(g.colorOf(m)));
      if (!eligible.length) return;
      const mode = await g.chooseOption(seat, "Guilt:", [
        { id: "one", label: "Suppress one black or red mood" },
        { id: "all", label: "Suppress ALL black and red moods" },
        { id: "skip", label: "Do nothing" },
      ]);
      if (mode === "skip") return;
      if (mode === "all") {
        for (const m of eligible) g.suppress(m, { source: iid });
      } else {
        const t = await g.chooseMood(seat, { eligible, text: "Choose a black or red mood to suppress." });
        if (t != null) g.suppress(t, { source: iid });
      }
    },
  },

  15: {
    // Honor: chosen player goes first each round (handled at round start)
    afterPlay: async (g, iid, seat) => {
      const pick = await g.choosePlayer(seat, {
        eligible: g.players.map((p) => p.seat),
        text: "Choose a player to go first each round.",
      });
      g.mood.get(iid).chosenPlayer = pick;
      g.log(`${g.player(pick).name} will go first each round while ${g.nameOf(iid)} is in play.`);
    },
  },

  16: {
    // Idealism: extra play; your moods use higher printed totals (handled in Game.value)
    afterPlay: async (g, iid, seat) => g.grantExtraPlay(seat, { label: "Idealism" }),
  },

  17: {
    // Kindness: extra play if printed value 1/3/5
    afterPlay: async (g, iid, seat) =>
      g.grantExtraPlay(seat, {
        label: "Kindness",
        filter: (gg, c) => [1, 3, 5].includes(printedPrimary(c, gg)),
      }),
  },

  18: { value: (g, iid) => (g.countMoodsWithColors(["Green", "Blue"]) >= 2 ? g.def(iid).secondary : g.def(iid).primary) }, // Loyalty

  19: {
    // Meekness: suppress all moods with value 5+
    afterPlay: async (g, iid, seat) => {
      const targets = g.allMoods().filter((m) => m !== iid && g.value(m) >= 5);
      for (const m of targets) g.suppress(m, { source: iid });
    },
  },

  20: {
    // Pacifism: up to two players, suppress one mood each
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => m !== iid,
        act: async (m) => g.suppress(m, { source: iid }),
        what: "suppress one of their moods",
      });
    },
  },

  21: { value: (g, iid) => (g.mood.get(iid).playedRound === g.round ? g.def(iid).secondary : g.def(iid).primary) }, // Patience

  22: {
    // Pride: keep playing until you have as many moods as the chosen player
    afterPlay: async (g, iid, seat) => {
      const elig = g.players
        .filter((p) => p.seat !== seat && p.moods.length > g.moodsOf(seat).length)
        .map((p) => p.seat);
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose a player with more moods than you? (You may keep playing until you match them.)",
      });
      if (pick == null) return;
      g.grantExtraPlay(seat, {
        label: "Pride",
        multi: true,
        available: (gg) => gg.moodsOf(seat).length < gg.moodsOf(pick).length,
      });
    },
  },

  23: {
    // Repentance: choose a number; suppress all other moods with that value until end of round
    afterPlay: async (g, iid, seat) => {
      const yes = await g.confirm(seat, "Repentance: choose a number to suppress all other moods with that value?");
      if (!yes) return;
      const n = await g.chooseNumber(seat, "Choose a value.");
      for (const m of g.allMoods()) {
        if (m !== iid && g.value(m) === n) g.suppress(m, { type: "round" });
      }
    },
  },

  24: {
    // Scorn: suppress a mood until end of round; each time you play another mood,
    // may suppress a mood sharing a color with it
    afterPlay: async (g, iid, seat) => {
      const t = await g.chooseMood(seat, {
        eligible: g.allMoods().filter((m) => m !== iid),
        text: "Choose a mood to suppress until end of round.",
      });
      if (t != null) g.suppress(t, { type: "round" });
    },
    onControllerPlayed: async (g, iid, played, seat) => {
      const col = g.colorOf(played);
      const elig = g.allMoods().filter((m) => m !== iid && g.colorOf(m) === col);
      const t = await g.chooseMood(seat, {
        eligible: elig,
        optional: true,
        text: `Scorn: suppress a ${col.toLowerCase()} mood until end of round?`,
      });
      if (t != null) g.suppress(t, { type: "round" });
    },
  },

  25: {
    // Shame: discard a card; suppress all other moods sharing its color
    afterPlay: async (g, iid, seat) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Discard a card to suppress all other moods of its color? (Skip to decline.)",
      });
      if (!picks.length) return;
      const col = printedColor(picks[0], g);
      g.discardFromHand(seat, picks[0]);
      for (const m of g.allMoods()) {
        if (m !== iid && g.colorOf(m) === col) g.suppress(m, { source: iid });
      }
    },
  },

  26: {
    // Validation: extra play; more extra plays when you play 0/1-value moods
    afterPlay: async (g, iid, seat) => g.grantExtraPlay(seat, { label: "Validation" }),
    onControllerPlayed: async (g, iid, played, seat) => {
      if ([0, 1].includes(g.def(played).primary)) {
        g.grantExtraPlay(seat, { label: "Validation" });
        g.log(`${g.player(seat).name} may play an additional mood (Validation).`);
      }
    },
  },

  // ===== BLUE =====

  27: { value: twoPlusColors("Red", "Green") }, // Ambivalence

  28: {
    // Anxiety: up to two players, return one odd-value mood each to hand
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => gg.value(m) % 2 === 1,
        act: async (m, s) => g.toHand(m, g.controllerOf(m)),
        what: "return a mood with an odd value to its player's hand",
      });
    },
  },

  29: {
    // Avoidance: choose a direction; each player passes one of their moods along
    afterPlay: async (g, iid, seat) => {
      const dir = await g.chooseOption(seat, "Choose a direction:", [
        { id: "1", label: "Left (next in turn order)" },
        { id: "-1", label: "Right (previous in turn order)" },
      ]);
      const d = Number(dir);
      const n = g.players.length;
      const transfers = [];
      for (let i = 0; i < n; i++) {
        const s = (seat + i) % n;
        if (!g.moodsOf(s).length) continue;
        const m = await g.chooseMood(s, {
          eligible: g.moodsOf(s),
          text: "Avoidance: choose one of your moods to give to the next player.",
        });
        if (m != null) transfers.push({ m, to: (s + d + n) % n });
      }
      for (const t of transfers) g.giveMood(t.m, t.to);
    },
  },

  30: {
    // Bashfulness: after scoring, if you won, bottom of deck + draw
    afterPlay: async (g, iid, seat) => {
      g.afterScoringQueue.push({ kind: "bashfulness", iid, seat, n: g.mood.get(iid).playedN });
    },
  },

  31: {
    // Confusion: choose a direction; each player passes a hand card along
    afterPlay: async (g, iid, seat) => {
      const dir = await g.chooseOption(seat, "Choose a direction:", [
        { id: "1", label: "Left (next in turn order)" },
        { id: "-1", label: "Right (previous in turn order)" },
      ]);
      const d = Number(dir);
      const n = g.players.length;
      const transfers = [];
      for (let i = 0; i < n; i++) {
        const s = (seat + i) % n;
        if (!g.player(s).hand.length) continue;
        const picks = await g.chooseCards(s, {
          eligible: g.player(s).hand,
          min: 1,
          max: 1,
          zone: "hand",
          text: "Confusion: choose a card to give to the next player.",
        });
        if (picks.length) transfers.push({ c: picks[0], to: (s + d + n) % n });
      }
      for (const t of transfers) {
        g.toHand(t.c, t.to, { silent: true });
        g.log(`A card changes hands to ${g.player(t.to).name}.`);
      }
    },
  },

  32: {}, // Creativity (copying is handled in Game.playCard)

  33: {
    // Curiosity: a player reveals a random card; if it shares a color with any mood, value 6
    afterPlay: async (g, iid, seat) => {
      const elig = g.players.filter((p) => p.hand.length).map((p) => p.seat);
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose a player to reveal a random card?",
      });
      if (pick == null) return;
      const card = rand(g.player(pick).hand);
      const col = printedColor(card, g);
      g.log(`${g.player(pick).name} reveals ${cards[g.inst(card).num].name} at random.`);
      if (g.allMoods().some((m) => g.colorOf(m) === col)) {
        g.mood.get(iid).valueSet = 6;
        g.log(`${g.nameOf(iid)}'s value becomes 6.`);
      }
    },
  },

  34: {
    // Denial: choose two other moods; if they share a color or value, both to hands
    afterPlay: async (g, iid, seat) => {
      const elig = g.allMoods().filter((m) => m !== iid);
      const picks = await g.chooseMoods(seat, {
        eligible: elig,
        min: 0,
        max: 2,
        text: "Choose two other moods (returned to hands if they share a color or value).",
      });
      if (picks.length !== 2) return;
      const [a, b] = picks;
      if (g.colorOf(a) === g.colorOf(b) || g.value(a) === g.value(b)) {
        g.toHand(a, g.controllerOf(a));
        g.toHand(b, g.controllerOf(b));
      } else {
        g.log("The chosen moods don't match; nothing happens.");
      }
    },
  },

  35: {
    // Disorientation: choose a number; all other moods with that value go to hands
    afterPlay: async (g, iid, seat) => {
      const yes = await g.confirm(seat, "Disorientation: choose a number to bounce all other moods with that value?");
      if (!yes) return;
      const n = await g.chooseNumber(seat, "Choose a value.");
      const targets = g.allMoods().filter((m) => m !== iid && g.value(m) === n);
      for (const m of targets) g.toHand(m, g.controllerOf(m));
    },
  },

  36: {
    // Doubt: bottom-deck any number of hand cards, draw that many; their colors
    // can't be played next round
    afterPlay: async (g, iid, seat) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 0,
        max: g.player(seat).hand.length,
        zone: "hand",
        text: "Reveal any number of cards to put on the bottom of the deck (their colors can't be played next round).",
      });
      if (!picks.length) return;
      const colors = [...new Set(picks.map((c) => printedColor(c, g)))];
      g.log(`${g.player(seat).name} reveals ${picks.map((c) => cards[g.inst(c).num].name).join(", ")}.`);
      for (const c of picks) g.toDeckBottom(c, { silent: true });
      g.drawCards(seat, picks.length);
      g.doubtColors = { colors, round: g.round + 1 };
      g.log(`Next round, no one may play ${colors.join(" or ")} moods.`);
    },
  },

  37: {
    // Duplicity: extra play; may repeat other moods' after-play effects
    afterPlay: async (g, iid, seat) => g.grantExtraPlay(seat, { label: "Duplicity" }),
    onControllerPlayed: async (g, iid, played, seat) => {
      if (!effects[g.effNum(played)]?.afterPlay) return;
      const yes = await g.confirm(seat, `Duplicity: repeat ${g.nameOf(played)}'s "after playing" effect?`);
      if (yes) await g.repeatAfterPlay(played, seat);
    },
  },

  38: {
    // Fear: may bounce one of your other moods; extra play
    afterPlay: async (g, iid, seat) => {
      const pick = await g.chooseMood(seat, {
        eligible: g.moodsOf(seat).filter((m) => m !== iid),
        optional: true,
        text: "Return one of your other moods to your hand?",
      });
      if (pick != null) g.toHand(pick, seat);
      g.grantExtraPlay(seat, { label: "Fear" });
    },
  },

  39: {
    // Fickleness: bounce all moods of the most common color(s), except itself
    afterPlay: async (g, iid, seat) => {
      const common = mostCommonMoodColors(g);
      const targets = g.allMoods().filter((m) => m !== iid && common.includes(g.colorOf(m)));
      for (const m of targets) g.toHand(m, g.controllerOf(m));
    },
  },

  40: {
    // Guile: cost — discard two cards; steal an opponent's mood
    canPay: (g, seat, iid) => g.player(seat).hand.filter((c) => c !== iid).length >= 2,
    pay: async (g, seat, iid) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 2,
        max: 2,
        zone: "hand",
        text: "Cost: discard two cards.",
      });
      for (const c of picks) g.discardFromHand(seat, c);
    },
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).flatMap((s) => g.moodsOf(s));
      const pick = await g.chooseMood(seat, { eligible: elig, text: "Choose an opponent's mood. It becomes yours." });
      if (pick != null) g.giveMood(pick, seat);
    },
  },

  41: {
    // Hesitation: bounce a red/green mood, or all of them
    afterPlay: async (g, iid, seat) => {
      const eligible = g.allMoods().filter((m) => m !== iid && ["Red", "Green"].includes(g.colorOf(m)));
      if (!eligible.length) return;
      const mode = await g.chooseOption(seat, "Hesitation:", [
        { id: "one", label: "Return one red or green mood to its player's hand" },
        { id: "all", label: "Return ALL red and green moods to their players' hands" },
        { id: "skip", label: "Do nothing" },
      ]);
      if (mode === "skip") return;
      if (mode === "all") {
        for (const m of eligible) g.toHand(m, g.controllerOf(m));
      } else {
        const t = await g.chooseMood(seat, { eligible, text: "Choose a red or green mood." });
        if (t != null) g.toHand(t, g.controllerOf(t));
      }
    },
  },

  42: {
    // Imagination: all moods are the chosen color (latest Imagination wins; see Game.colorOf)
    afterPlay: async (g, iid, seat) => {
      const col = await g.chooseColor(seat, "Choose a color. All moods are that color.");
      g.mood.get(iid).chosenColor = col;
      g.log(`All moods are now ${col.toLowerCase()}.`);
    },
  },

  43: {
    // Indecisiveness: chosen opponents with 2+ moods bounce a random mood
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).filter((s) => g.moodsOf(s).length >= 2);
      const picks = await g.choosePlayers(seat, {
        eligible: elig,
        min: 0,
        max: elig.length,
        text: "Choose any number of opponents with two or more moods (each bounces a random mood).",
      });
      for (const s of picks) {
        const m = rand(g.moodsOf(s));
        g.toHand(m, s);
      }
    },
  },

  44: {}, // Indifference (vanilla)

  45: {
    // Insecurity: extra play; that mood returns to your hand after scoring
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, { label: "Insecurity", rider: "insecurity", riderSeat: seat });
    },
  },

  46: moodCost({ min: 1, max: 99, dest: "hand", what: "one or more of your moods into your hand" }), // Neurosis

  47: { value: twoPlusColors("White", "Black") }, // Obsession

  48: {
    // Panic: up to two players, bounce one of their moods (not this one)
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => m !== iid,
        act: async (m) => g.toHand(m, g.controllerOf(m)),
        what: "return one of their moods to their hand",
      });
    },
  },

  49: {
    // Rationalization: redraw your hand, or everyone passes their hand along
    afterPlay: async (g, iid, seat) => {
      const mode = await g.chooseOption(seat, "Rationalization:", [
        { id: "redraw", label: "Put your hand on the bottom of the deck, draw that many" },
        { id: "rotate", label: "Everyone gives their hand to the next player" },
        { id: "skip", label: "Do nothing" },
      ]);
      if (mode === "skip") return;
      if (mode === "redraw") {
        const handCards = [...g.player(seat).hand];
        for (const c of handCards) g.toDeckBottom(c, { silent: true });
        g.log(`${g.player(seat).name} puts their hand on the bottom of the deck.`);
        g.drawCards(seat, handCards.length);
      } else {
        const dir = await g.chooseOption(seat, "Choose a direction:", [
          { id: "1", label: "Left (next in turn order)" },
          { id: "-1", label: "Right (previous in turn order)" },
        ]);
        const d = Number(dir);
        const n = g.players.length;
        const hands = g.players.map((p) => [...p.hand]);
        for (const p of g.players) p.hand = [];
        for (let s = 0; s < n; s++) {
          const to = (s + d + n) % n;
          g.player(to).hand.push(...hands[s]);
        }
        g.log(`Everyone gives their hand to the next player.`);
      }
    },
  },

  50: {
    // Regret: cost — bounce two of your moods; steal-to-hand an opponent's mood
    ...moodCost({ min: 2, dest: "hand", what: "two of your moods into your hand" }),
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).flatMap((s) => g.moodsOf(s));
      const pick = await g.chooseMood(seat, { eligible: elig, text: "Put an opponent's mood into YOUR hand." });
      if (pick != null) g.toHand(pick, seat);
    },
  },

  51: {
    // Sneakiness: after scoring, swap scores with chosen opponent
    afterPlay: async (g, iid, seat) => {
      const pick = await g.choosePlayer(seat, {
        eligible: g.enemiesOf(seat),
        text: "Choose an opponent to swap scores with after scoring this round.",
      });
      g.afterScoringQueue.push({ kind: "sneakiness", iid, seat, target: pick, n: g.mood.get(iid).playedN });
    },
  },

  52: {
    // Worry: bounce one of your white/black moods to bounce up to two cheap moods
    afterPlay: async (g, iid, seat) => {
      const mine = g.moodsOf(seat).filter((m) => m !== iid && ["White", "Black"].includes(g.colorOf(m)));
      const pick = await g.chooseMood(seat, {
        eligible: mine,
        optional: true,
        text: "Return one of your white or black moods to your hand?",
      });
      if (pick == null) return;
      g.toHand(pick, seat);
      const elig = g.allMoods().filter((m) => m !== iid && g.value(m) <= 3);
      const targets = await g.chooseMoods(seat, {
        eligible: elig,
        min: 0,
        max: 2,
        text: "Return up to two moods with value 3 or less to their players' hands.",
      });
      for (const m of targets) g.toHand(m, g.controllerOf(m));
    },
  },

  // ===== BLACK =====

  53: {
    // Ambition: discard a card for an extra play
    afterPlay: async (g, iid, seat) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Discard a card to play an additional mood? (Skip to decline.)",
      });
      if (picks.length) {
        g.discardFromHand(seat, picks[0]);
        g.grantExtraPlay(seat, { label: "Ambition" });
      }
    },
  },

  54: {
    // Angst: discard one of your blue/red moods to play a mood from the discard pile
    afterPlay: async (g, iid, seat) => {
      const mine = g.moodsOf(seat).filter((m) => m !== iid && ["Blue", "Red"].includes(g.colorOf(m)));
      const pick = await g.chooseMood(seat, {
        eligible: mine,
        optional: true,
        text: "Put one of your blue or red moods into the discard pile? (You may then play a mood from the discard pile.)",
      });
      if (pick == null) return;
      g.toDiscard(pick);
      g.grantExtraPlay(seat, { label: "Angst", fromZone: "discard" });
    },
  },

  55: {}, // Apathy (vanilla)

  56: {
    // Betrayal: lend one of your moods to another player until after scoring
    afterPlay: async (g, iid, seat) => {
      const pick = await g.chooseMood(seat, {
        eligible: g.moodsOf(seat),
        text: "Give one of your moods to another player (it returns after scoring).",
      });
      if (pick == null) return;
      const to = await g.choosePlayer(seat, { eligible: g.opponentsOf(seat), text: "Give it to whom?" });
      g.giveMood(pick, to);
      g.afterScoringQueue.push({ kind: "betrayal", iid, seat, target: pick, n: g.mood.get(iid).playedN });
    },
  },

  57: {
    // Bitterness: discard all other moods of the most common color(s)
    afterPlay: async (g, iid, seat) => {
      const common = mostCommonMoodColors(g);
      const targets = g.allMoods().filter((m) => m !== iid && common.includes(g.colorOf(m)));
      for (const m of targets) g.toDiscard(m);
    },
  },

  58: {
    // Condescension: give a hand card to another player; value becomes 6
    afterPlay: async (g, iid, seat) => {
      if (!g.player(seat).hand.length) return;
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Give a card to another player to set this value to 6? (Skip to decline.)",
      });
      if (!picks.length) return;
      const to = await g.choosePlayer(seat, { eligible: g.opponentsOf(seat), text: "Give it to whom?" });
      g.toHand(picks[0], to, { silent: true });
      g.log(`${g.player(seat).name} gives a card to ${g.player(to).name}.`);
      g.mood.get(iid).valueSet = 6;
      g.log(`${g.nameOf(iid)}'s value becomes 6.`);
    },
  },

  59: {
    // Contempt: discard a green/white mood, or all of them
    afterPlay: async (g, iid, seat) => {
      const eligible = g.allMoods().filter((m) => m !== iid && ["Green", "White"].includes(g.colorOf(m)));
      if (!eligible.length) return;
      const mode = await g.chooseOption(seat, "Contempt:", [
        { id: "one", label: "Put one green or white mood into the discard pile" },
        { id: "all", label: "Put ALL green and white moods into the discard pile" },
        { id: "skip", label: "Do nothing" },
      ]);
      if (mode === "skip") return;
      if (mode === "all") {
        for (const m of eligible) g.toDiscard(m);
      } else {
        const t = await g.chooseMood(seat, { eligible, text: "Choose a green or white mood." });
        if (t != null) g.toDiscard(t);
      }
    },
  },

  60: {
    // Corruption: recycle two discard cards, or this round's winner wins double
    afterPlay: async (g, iid, seat) => {
      const mode = await g.chooseOption(seat, "Corruption:", [
        { id: "recycle", label: "Put up to two discard pile cards on the bottom of the deck, draw that many" },
        { id: "double", label: "The winner of this round wins TWO rounds" },
        { id: "skip", label: "Do nothing" },
      ]);
      if (mode === "skip") return;
      if (mode === "double") {
        g.corruptionDouble = true;
        g.log("The winner of this round will win two rounds.");
      } else {
        const picks = await g.chooseCards(seat, {
          eligible: [...g.discard],
          min: 0,
          max: 2,
          zone: "discard",
          text: "Choose up to two cards from the discard pile.",
        });
        for (const c of picks) g.toDeckBottom(c, { silent: true });
        if (picks.length) {
          g.log(`${g.player(seat).name} recycles ${picks.length} card(s) and draws.`);
          g.drawCards(seat, picks.length);
        }
      }
    },
  },

  61: {
    // Cruelty: chosen opponents with 2+ moods discard a random mood
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).filter((s) => g.moodsOf(s).length >= 2);
      const picks = await g.choosePlayers(seat, {
        eligible: elig,
        min: 0,
        max: elig.length,
        text: "Choose any number of opponents with two or more moods (each discards a random mood).",
      });
      for (const s of picks) {
        const m = rand(g.moodsOf(s));
        g.toDiscard(m);
      }
    },
  },

  62: {
    // Cynicism: give a discard card to an opponent's hand; value becomes 6
    afterPlay: async (g, iid, seat) => {
      if (!g.discard.length) return;
      const picks = await g.chooseCards(seat, {
        eligible: [...g.discard],
        min: 0,
        max: 1,
        zone: "discard",
        text: "Put a discard pile card into an opponent's hand to set this value to 6? (Skip to decline.)",
      });
      if (!picks.length) return;
      const to = await g.choosePlayer(seat, { eligible: g.enemiesOf(seat), text: "Whose hand?" });
      g.toHand(picks[0], to);
      g.mood.get(iid).valueSet = 6;
      g.log(`${g.nameOf(iid)}'s value becomes 6.`);
    },
  },

  63: { value: twoPlusColors("Green", "White") }, // Disgust

  64: {
    // Envy: cost — discard one of your moods; +2 per mood of your moodiest opponent
    ...moodCost({ min: 1, dest: "discard", what: "one of your moods into the discard pile" }),
    bonus: (g, iid) => {
      const seat = g.controllerOf(iid);
      const most = Math.max(0, ...g.enemiesOf(seat).map((s) => g.moodsOf(s).length));
      return 2 * most;
    },
  },

  65: {
    // Grief: play up to two additional moods from the discard pile
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, { label: "Grief", fromZone: "discard" });
      g.grantExtraPlay(seat, { label: "Grief", fromZone: "discard" });
    },
  },

  66: {
    // Hate: bottom-deck any mood to draw a card
    afterPlay: async (g, iid, seat) => {
      const pick = await g.chooseMood(seat, {
        eligible: g.allMoods().filter((m) => m !== iid),
        optional: true,
        text: "Put any mood on the bottom of the deck to draw a card?",
      });
      if (pick == null) return;
      g.toDeckBottom(pick);
      g.drawCards(seat, 1);
    },
  },

  67: {
    // Intimidation: a player gives you a card of their choice; you may play it
    afterPlay: async (g, iid, seat) => {
      const elig = g.opponentsOf(seat).filter((s) => g.player(s).hand.length);
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose a player to reveal and hand over a card?",
      });
      if (pick == null) return;
      const picks = await g.chooseCards(pick, {
        eligible: g.player(pick).hand,
        min: 1,
        max: 1,
        zone: "hand",
        text: `Intimidation: choose a card to reveal and give to ${g.player(seat).name}.`,
      });
      const card = picks[0];
      g.log(`${g.player(pick).name} reveals ${cards[g.inst(card).num].name} and gives it to ${g.player(seat).name}.`);
      g.toHand(card, seat, { silent: true });
      g.grantExtraPlay(seat, { label: "Intimidation", filter: (gg, c) => c === card });
    },
  },

  68: {
    // Malice: a player picks two of their moods; those + all color-sharing moods are discarded
    afterPlay: async (g, iid, seat) => {
      const elig = g.players.filter((p) => p.moods.length >= 2).map((p) => p.seat);
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        text: "Choose a player with two or more moods.",
      });
      if (pick == null) return;
      const two = await g.chooseMoods(pick, {
        eligible: g.moodsOf(pick),
        min: 2,
        max: 2,
        text: "Malice: choose two of your moods (they and all moods sharing their colors are discarded).",
      });
      if (two.length < 2) return;
      const colors = new Set(two.map((m) => g.colorOf(m)));
      const targets = g.allMoods().filter((m) => two.includes(m) || (m !== iid && colors.has(g.colorOf(m))));
      for (const m of targets) g.toDiscard(m);
    },
  },

  69: {}, // Melancholy (play from discard; handled in Game.legalPlays)

  70: {
    // Misery: secondary if two discard cards share a color
    value: (g, iid) => {
      const counts = {};
      for (const c of g.discard) {
        const col = cards[g.inst(c).num].color;
        counts[col] = (counts[col] || 0) + 1;
      }
      return Object.values(counts).some((c) => c >= 2) ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  71: {
    // Paranoia: a player bottom-decks a random hand card; you draw
    afterPlay: async (g, iid, seat) => {
      const elig = g.players.filter((p) => p.hand.length).map((p) => p.seat);
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose a player with cards in hand? (They lose a random card; you draw.)",
      });
      if (pick == null) return;
      const card = rand(g.player(pick).hand);
      g.log(`${g.player(pick).name} reveals ${cards[g.inst(card).num].name} at random; it goes to the bottom of the deck.`);
      g.toDeckBottom(card, { silent: true });
      g.drawCards(seat, 1);
    },
  },

  72: { value: twoPlusColors("Blue", "Red") }, // Pity

  73: {
    // Rejection: choose two other moods; if they match (color/value) discard them
    afterPlay: async (g, iid, seat) => {
      const elig = g.allMoods().filter((m) => m !== iid);
      const picks = await g.chooseMoods(seat, {
        eligible: elig,
        min: 0,
        max: 2,
        text: "Choose two other moods (discarded if they share a color or value).",
      });
      if (picks.length !== 2) return;
      const [a, b] = picks;
      if (g.colorOf(a) === g.colorOf(b) || g.value(a) === g.value(b)) {
        g.toDiscard(a);
        g.toDiscard(b);
      } else {
        g.log("The chosen moods don't match; nothing happens.");
      }
    },
  },

  74: { bonus: (g) => 2 * g.discard.length }, // Sadness

  75: moodCost({ min: 1, max: 99, dest: "discard", what: "one or more of your moods into the discard pile" }), // Self-Loathing

  76: {
    // Spite: up to two players, discard one of their even-value moods
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => gg.value(m) % 2 === 0,
        act: async (m) => g.toDiscard(m),
        what: "discard a mood with an even value (0 is even)",
      });
    },
  },

  77: {
    // Superiority: secondary if you have strictly more moods than each other player
    value: (g, iid) => {
      const seat = g.controllerOf(iid);
      const mine = g.moodsOf(seat).length;
      const ok = g.opponentsOf(seat).every((s) => g.moodsOf(s).length < mine);
      return ok ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  78: {
    // Suspicion: chosen players discard a hand card of their choice
    afterPlay: async (g, iid, seat) => {
      const elig = g.players.filter((p) => p.hand.length).map((p) => p.seat);
      const picks = await g.choosePlayers(seat, {
        eligible: elig,
        min: 0,
        max: elig.length,
        text: "Choose any number of players (each discards a card from their hand).",
      });
      const n = g.players.length;
      for (let i = 0; i < n; i++) {
        const s = (seat + i) % n;
        if (!picks.includes(s) || !g.player(s).hand.length) continue;
        const sel = await g.chooseCards(s, {
          eligible: g.player(s).hand,
          min: 1,
          max: 1,
          zone: "hand",
          text: "Suspicion: choose a card to discard.",
        });
        if (sel.length) g.discardFromHand(s, sel[0]);
      }
    },
  },

  79: {
    // Vanity: +1 per your mood; +3 each instead if your hand is empty
    bonus: (g, iid) => {
      const seat = g.controllerOf(iid);
      const per = g.player(seat).hand.length === 0 ? 3 : 1;
      return per * g.moodsOf(seat).length;
    },
  },

  // ===== RED =====

  80: {
    // Anger: discard any number of moods with total value 5 or less
    afterPlay: async (g, iid, seat) => {
      const elig = g.allMoods().filter((m) => m !== iid);
      const picks = await g.chooseMoods(seat, {
        eligible: elig,
        min: 0,
        max: elig.length,
        maxTotal: 5,
        text: "Discard any number of moods with TOTAL value 5 or less.",
      });
      for (const m of picks) g.toDiscard(m);
    },
  },

  81: {
    // Animosity: secondary if any opponent has 3+ cards in hand
    value: (g, iid) => {
      const seat = g.controllerOf(iid);
      return g.enemiesOf(seat).some((s) => g.player(s).hand.length >= 3)
        ? g.def(iid).secondary
        : g.def(iid).primary;
    },
  },

  82: {
    // Arrogance: borrow a white/blue mood; give it back when this leaves play
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).filter((s) =>
        g.moodsOf(s).some((m) => ["White", "Blue"].includes(g.colorOf(m)))
      );
      const pick = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose an opponent? (They give you one of their white or blue moods until this leaves play.)",
      });
      if (pick == null) return;
      const theirs = g.moodsOf(pick).filter((m) => ["White", "Blue"].includes(g.colorOf(m)));
      const m = await g.chooseMood(pick, {
        eligible: theirs,
        text: `Arrogance: choose one of your white or blue moods to give to ${g.player(seat).name}.`,
      });
      if (m == null) return;
      g.giveMood(m, seat);
      g.mood.get(iid).taken.push({ iid: m, fromSeat: pick, takenBy: seat });
    },
    onLeave: (g, iid, ms) => {
      for (const t of ms.taken) {
        if (g.inPlay(t.iid) && g.controllerOf(t.iid) === t.takenBy) {
          g.giveMood(t.iid, t.fromSeat);
          g.log(`${g.nameOf(t.iid)} is given back.`);
        }
      }
    },
  },

  83: {}, // Boredom (vanilla)

  84: {
    // Bravado: discard one of your other moods for an extra play
    afterPlay: async (g, iid, seat) => {
      const pick = await g.chooseMood(seat, {
        eligible: g.moodsOf(seat).filter((m) => m !== iid),
        optional: true,
        text: "Put one of your other moods into the discard pile to play an additional mood?",
      });
      if (pick == null) return;
      g.toDiscard(pick);
      g.grantExtraPlay(seat, { label: "Bravado" });
    },
  },

  85: {
    // Chaos: shuffle all moods and deal them out, starting with you
    afterPlay: async (g, iid, seat) => {
      const all = shuffle([...g.allMoods()]);
      const n = g.players.length;
      all.forEach((m, i) => g.giveMood(m, (seat + i) % n, { silent: true }));
      g.log("All moods are shuffled together and dealt back out!");
    },
  },

  86: {
    // Compulsion: chosen player gives you a hand card of their choice
    afterPlay: async (g, iid, seat) => {
      const elig = g.opponentsOf(seat).filter((s) => g.player(s).hand.length);
      const pick = await g.choosePlayer(seat, { eligible: elig, text: "Choose another player. They give you a card." });
      if (pick == null) return;
      const sel = await g.chooseCards(pick, {
        eligible: g.player(pick).hand,
        min: 1,
        max: 1,
        zone: "hand",
        text: `Compulsion: choose a card to give to ${g.player(seat).name}.`,
      });
      if (sel.length) {
        g.toHand(sel[0], seat, { silent: true });
        g.log(`${g.player(pick).name} gives a card to ${g.player(seat).name}.`);
      }
    },
  },

  87: { afterPlay: discardToSetValue((g, c) => [4, 5, 6].includes(printedPrimary(c, g)), 5, "a card with 4-6 top right") }, // Embarrassment

  88: { value: twoPlusColors("Black", "Green") }, // Excitement

  89: moodCost({ min: 1, dest: "discard", what: "one of your moods into the discard pile" }), // Exhilaration (extra scoring in Game.scoreRound)

  90: { value: twoPlusColors("White", "Blue") }, // Frustration

  91: {
    // Fury: each player discards one of their highest-value moods
    afterPlay: async (g, iid, seat) => {
      const n = g.players.length;
      for (let i = 0; i < n; i++) {
        const s = (seat + i) % n;
        const moods = g.moodsOf(s);
        if (!moods.length) continue;
        const top = Math.max(...moods.map((m) => g.value(m)));
        const elig = moods.filter((m) => g.value(m) === top);
        let pick = elig[0];
        if (elig.length > 1) {
          pick = await g.chooseMood(s, { eligible: elig, text: "Fury: choose one of your highest-value moods to discard." });
        }
        if (pick != null) g.toDiscard(pick);
      }
    },
  },

  92: { value: (g, iid) => (g.mood.get(iid).playedRound === g.round ? g.def(iid).secondary : g.def(iid).primary) }, // Glee

  93: {
    // Gluttony: extra play; that mood is discarded after scoring
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, { label: "Gluttony", rider: "gluttony" });
    },
  },

  94: {
    // Hostility: discard one of your black/green moods to discard up to two cheap moods
    afterPlay: async (g, iid, seat) => {
      const mine = g.moodsOf(seat).filter((m) => m !== iid && ["Black", "Green"].includes(g.colorOf(m)));
      const pick = await g.chooseMood(seat, {
        eligible: mine,
        optional: true,
        text: "Put one of your black or green moods into the discard pile?",
      });
      if (pick == null) return;
      g.toDiscard(pick);
      const elig = g.allMoods().filter((m) => g.value(m) <= 3);
      const targets = await g.chooseMoods(seat, {
        eligible: elig,
        min: 0,
        max: 2,
        text: "Put up to two moods with value 3 or less into the discard pile.",
      });
      for (const m of targets) g.toDiscard(m);
    },
  },

  95: {
    // Infatuation: discard two of your other moods; value becomes 9
    afterPlay: async (g, iid, seat) => {
      const mine = g.moodsOf(seat).filter((m) => m !== iid);
      if (mine.length < 2) return;
      const picks = await g.chooseMoods(seat, {
        eligible: mine,
        min: 0,
        max: 2,
        text: "Put two of your other moods into the discard pile to set this value to 9? (Pick exactly two or none.)",
      });
      if (picks.length === 2) {
        for (const m of picks) g.toDiscard(m);
        g.mood.get(iid).valueSet = 9;
        g.log(`${g.nameOf(iid)}'s value becomes 9.`);
      }
    },
  },

  96: {
    // Instability: pick two moods of one opponent; they give you one, you give one back
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).filter((s) => g.moodsOf(s).length >= 2);
      const opp = await g.choosePlayer(seat, {
        eligible: elig,
        optional: true,
        text: "Choose an opponent with two or more moods?",
      });
      if (opp == null) return;
      const two = await g.chooseMoods(seat, {
        eligible: g.moodsOf(opp),
        min: 2,
        max: 2,
        text: "Choose two of their moods.",
      });
      if (two.length < 2) return;
      const give = await g.chooseMood(opp, {
        eligible: two,
        text: `Instability: choose which mood to give to ${g.player(seat).name}.`,
      });
      if (give == null) return;
      g.giveMood(give, seat);
      const back = await g.chooseMood(seat, {
        eligible: g.moodsOf(seat),
        text: `Give one of your moods to ${g.player(opp).name}.`,
      });
      if (back != null) g.giveMood(back, opp);
    },
  },

  97: {}, // Passion (extra scoring in Game.scoreRound)

  98: {
    // Rage: may discard all other moods with value 3 or less
    afterPlay: async (g, iid, seat) => {
      const targets = g.allMoods().filter((m) => m !== iid && g.value(m) <= 3);
      if (!targets.length) return;
      const yes = await g.confirm(seat, `Rage: put all ${targets.length} other mood(s) with value 3 or less into the discard pile?`);
      if (!yes) return;
      for (const m of targets) if (g.inPlay(m)) g.toDiscard(m);
    },
  },

  99: {
    // Rebellion: choose 0-3; discard all other moods with that value
    afterPlay: async (g, iid, seat) => {
      const n = await g.chooseNumber(seat, "Choose 0, 1, 2, or 3. All other moods with that value are discarded.", 0, 3);
      const targets = g.allMoods().filter((m) => m !== iid && g.value(m) === n);
      for (const m of targets) g.toDiscard(m);
    },
  },

  100: {
    // Recklessness: borrow an opponent's mood until after scoring; after scoring,
    // whoever holds this bottom-decks it and draws
    afterPlay: async (g, iid, seat) => {
      const elig = g.enemiesOf(seat).flatMap((s) => g.moodsOf(s));
      const pick = await g.chooseMood(seat, {
        eligible: elig,
        optional: true,
        text: "Take one of your opponents' moods until after scoring?",
      });
      let takenIid = null;
      let fromSeat = null;
      if (pick != null) {
        fromSeat = g.controllerOf(pick);
        g.giveMood(pick, seat);
        takenIid = pick;
      }
      g.afterScoringQueue.push({ kind: "recklessness", iid, seat, takenIid, fromSeat, n: g.mood.get(iid).playedN });
    },
  },

  101: {
    // Shock: up to two players, discard one of their moods with value 3 or less
    afterPlay: async (g, iid, seat) => {
      await upToTwoPlayersMoods(g, seat, iid, {
        filter: (gg, m) => gg.value(m) <= 3,
        act: async (m) => g.toDiscard(m),
        what: "discard a mood with value 3 or less",
      });
    },
  },

  102: {}, // Stubbornness (start-of-turn grant in Game.takeTurn)

  103: {
    // Thrill: bounce any number of your other moods; play that many extra moods
    afterPlay: async (g, iid, seat) => {
      const mine = g.moodsOf(seat).filter((m) => m !== iid);
      const picks = await g.chooseMoods(seat, {
        eligible: mine,
        min: 0,
        max: mine.length,
        text: "Return any number of your other moods to your hand (play that many additional moods).",
      });
      for (const m of picks) g.toHand(m, seat);
      for (let i = 0; i < picks.length; i++) g.grantExtraPlay(seat, { label: "Thrill" });
    },
  },

  104: { value: (g, iid) => (g.controllerOf(iid) === g.firstSeat ? g.def(iid).secondary : g.def(iid).primary) }, // Triumph

  105: {
    // Wrath: may discard ALL other moods
    afterPlay: async (g, iid, seat) => {
      const targets = g.allMoods().filter((m) => m !== iid);
      if (!targets.length) return;
      const yes = await g.confirm(seat, "Wrath: put ALL other moods into the discard pile?");
      if (!yes) return;
      for (const m of targets) if (g.inPlay(m)) g.toDiscard(m);
    },
  },

  106: {
    // Zeal: bottom-deck a hand card to draw a card
    afterPlay: async (g, iid, seat) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Put a card from your hand on the bottom of the deck to draw a card? (Skip to decline.)",
      });
      if (!picks.length) return;
      g.toDeckBottom(picks[0], { silent: true });
      g.log(`${g.player(seat).name} puts a card on the bottom of the deck.`);
      g.drawCards(seat, 1);
    },
  },

  // ===== GREEN =====

  107: {
    // Awe: no scoring this round; you pick next round's first player
    afterPlay: async (g, iid, seat) => {
      g.aweSeat = seat;
      g.log("There will be no scoring this round (Awe).");
    },
  },

  108: {
    // Bliss: cost — discard a card; moods sharing its color score two extra times
    canPay: (g, seat, iid) => g.player(seat).hand.filter((c) => c !== iid).length >= 1,
    pay: async (g, seat, iid) => {
      const picks = await g.chooseCards(seat, {
        eligible: g.player(seat).hand,
        min: 1,
        max: 1,
        zone: "hand",
        text: "Cost: discard a card (your moods sharing its color score two extra times).",
      });
      const col = printedColor(picks[0], g);
      g.discardFromHand(seat, picks[0]);
      return { color: col };
    },
    afterPlay: async (g, iid, seat, costCtx) => {
      // remember the discarded card's color even if the card later moves
      if (costCtx?.color) {
        g.mood.get(iid).chosenColor = costCtx.color;
        g.log(`${g.nameOf(iid)} is set to ${costCtx.color.toLowerCase()}.`);
      }
    },
  },

  109: {
    // Celebration: secondary if you have more colors among your moods than each other player
    value: (g, iid) => {
      const seat = g.controllerOf(iid);
      const colorsOf = (s) => new Set(g.moodsOf(s).map((m) => g.colorOf(m))).size;
      const mine = colorsOf(seat);
      const ok = g.opponentsOf(seat).every((s) => colorsOf(s) < mine);
      return ok ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  110: { afterPlay: discardToSetValue((g, c) => [0, 2, 4, 6].includes(printedPrimary(c, g)), 5, "a card with 0/2/4/6 top right") }, // Cheer

  111: { afterPlay: discardToSetValue((g, c) => [1, 3, 5].includes(printedPrimary(c, g)), 5, "a card with 1/3/5 top right") }, // Delight

  112: {
    // Determination: secondary if three or more moods share a color
    value: (g, iid) => {
      const counts = {};
      for (const m of g.allMoods()) {
        const c = g.colorOf(m);
        counts[c] = (counts[c] || 0) + 1;
      }
      return Object.values(counts).some((c) => c >= 3) ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  113: { value: twoPlusColors("Blue", "Black") }, // Disregard

  114: {
    // Eagerness: extra play if it shares a color with one of your moods
    afterPlay: async (g, iid, seat) =>
      g.grantExtraPlay(seat, {
        label: "Eagerness",
        filter: (gg, c) => gg.moodsOf(seat).some((m) => gg.colorOf(m) === printedColor(c, gg)),
      }),
  },

  115: { value: twoPlusColors("Red", "White") }, // Enjoyment

  116: {}, // Enthusiasm (extra scoring in Game.scoreRound)

  117: { bonus: (g) => g.allMoods().length }, // Euphoria (+1 per mood including itself)

  118: {
    // Fascination: reveal a blue/black card and give it away; value becomes 7
    afterPlay: async (g, iid, seat) => {
      const elig = g.player(seat).hand.filter((c) => ["Blue", "Black"].includes(printedColor(c, g)));
      const picks = await g.chooseCards(seat, {
        eligible: elig,
        min: 0,
        max: 1,
        zone: "hand",
        text: "Reveal a blue or black card and give it to another player to set this value to 7? (Skip to decline.)",
      });
      if (!picks.length) return;
      const to = await g.choosePlayer(seat, { eligible: g.opponentsOf(seat), text: "Give it to whom?" });
      g.log(`${g.player(seat).name} reveals ${cards[g.inst(picks[0]).num].name} and gives it to ${g.player(to).name}.`);
      g.toHand(picks[0], to, { silent: true });
      g.mood.get(iid).valueSet = 7;
      g.log(`${g.nameOf(iid)}'s value becomes 7.`);
    },
  },

  119: {
    // Fondness: secondary if each player has 3+ moods
    value: (g, iid) =>
      g.players.every((p) => p.moods.length >= 3) ? g.def(iid).secondary : g.def(iid).primary,
  },

  120: {
    // Generosity: chosen opponent may play an extra mood next turn
    afterPlay: async (g, iid, seat) => {
      const pick = await g.choosePlayer(seat, {
        eligible: g.enemiesOf(seat),
        text: "Choose an opponent. They may play an additional mood on their next turn.",
      });
      if (pick == null) return;
      g.player(pick).nextTurnPlays++;
      g.log(`${g.player(pick).name} may play an additional mood on their next turn.`);
    },
  },

  121: {
    // Grace: each of your turns, extra play from the discard pile if it shares a
    // color with one of your moods (also the turn it's played)
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, graceGrant(iid, seat));
    },
  },

  122: {
    // Happiness: secondary if one player has both a red and a white mood
    value: (g, iid) => {
      const ok = g.players.some((p) => {
        const cols = p.moods.map((m) => g.colorOf(m));
        return cols.includes("Red") && cols.includes("White");
      });
      return ok ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  123: {
    // Harmony: extra play from the discard pile
    afterPlay: async (g, iid, seat) => g.grantExtraPlay(seat, { label: "Harmony", fromZone: "discard" }),
  },

  124: {
    // Hope: extra play each of your turns while in play (also the turn it's played)
    afterPlay: async (g, iid, seat) => {
      g.grantExtraPlay(seat, hopeGrant(iid, seat));
    },
  },

  125: {
    // Joy: extra play on your next turn
    afterPlay: async (g, iid, seat) => {
      g.player(seat).nextTurnPlays++;
      g.log(`${g.player(seat).name} may play an additional mood on their next turn.`);
    },
  },

  126: {}, // Laziness (vanilla)

  127: {
    // Love: secondary if all five colors are among moods
    value: (g, iid) => {
      const present = new Set(g.allMoods().map((m) => g.colorOf(m)));
      return COLORS.every((c) => present.has(c)) ? g.def(iid).secondary : g.def(iid).primary;
    },
  },

  128: {
    // Nostalgia: may take a discard card to hand; extra play
    afterPlay: async (g, iid, seat) => {
      const picks = await g.chooseCards(seat, {
        eligible: [...g.discard],
        min: 0,
        max: 1,
        zone: "discard",
        text: "Put a card from the discard pile into your hand? (Skip to decline.)",
      });
      if (picks.length) g.toHand(picks[0], seat);
      g.grantExtraPlay(seat, { label: "Nostalgia" });
    },
  },

  129: { value: (g, iid) => (g.moodsOf(g.controllerOf(iid)).length % 2 === 0 ? g.def(iid).secondary : g.def(iid).primary) }, // Serenity

  130: { bonus: (g, iid) => g.player(g.controllerOf(iid)).hand.length }, // Sloth

  131: { value: (g, iid) => (g.moodsOf(g.controllerOf(iid)).length % 2 === 1 ? g.def(iid).secondary : g.def(iid).primary) }, // Tranquility

  132: { value: (g, iid) => (g.discardedThisRound ? g.def(iid).secondary : g.def(iid).primary) }, // Vulnerability

  133: {
    // Wonder: choose a color; +2 per mood and discard card of that color
    afterPlay: async (g, iid, seat) => {
      const col = await g.chooseColor(seat, "Choose a color for Wonder.");
      g.mood.get(iid).chosenColor = col;
      g.log(`${g.nameOf(iid)} is set to ${col.toLowerCase()}.`);
    },
    bonus: (g, iid) => {
      const col = g.mood.get(iid).chosenColor;
      if (!col) return 0;
      const inPlay = g.allMoods().filter((m) => g.colorOf(m) === col).length;
      const inDiscard = g.discard.filter((c) => cards[g.inst(c).num].color === col).length;
      return 2 * (inPlay + inDiscard);
    },
  },
};

effects[134] = effects[127]; // Love (alternate printing)

// Hope (#124) and Grace (#121) grants must check the source is still in play
// and controlled by the player at the moment the extra card is played.
export function hopeGrant(iid, seat) {
  return {
    label: "Hope",
    available: (g) => g.inPlay(iid) && g.controllerOf(iid) === seat,
  };
}

export function graceGrant(iid, seat) {
  return {
    label: "Grace",
    fromZone: "discard",
    filter: (g, c) => g.moodsOf(seat).some((m) => g.colorOf(m) === printedColor(c, g)),
    available: (g) => g.inPlay(iid) && g.controllerOf(iid) === seat,
  };
}
