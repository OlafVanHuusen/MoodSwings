// Loads and normalizes the scraped card data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "cards.json"), "utf8"));

export const COLORS = ["White", "Blue", "Black", "Red", "Green"];

// Card #134 is an alternate printing of #127 (Love); it is excluded from the
// gameplay pool so the playable set is the 133 unique cards.
export const cards = {};
for (const c of raw) {
  const bang = / !$/.test(c.name);
  cards[c.number] = {
    num: c.number,
    id: c.id,
    name: c.name.replace(/ !$/, ""),
    color: c.color,
    rarity: c.rarity,
    primary: c.dice.length ? Number(c.dice[0]) : 0,
    secondary: c.dice.length > 1 ? Number(c.dice[1]) : null,
    bang, // printed "!" marker: card has an ongoing/continuous effect
    timings: c.timings,
    effect: c.effect || null,
    notes: c.notes,
    artist: c.artist,
    image: c.image,
  };
}

export const POOL = Object.values(cards)
  .filter((c) => c.num !== 134)
  .map((c) => c.num);

const RARITY_COUNTS = { Common: 23, Uncommon: 14, Rare: 6, Mythic: 2 };

export function buildDeck(mode, rng = Math.random) {
  if (mode === "full") return shuffle([...POOL], rng);
  // "random45": fresh Secret Lair style deck respecting rarity distribution
  const byRarity = { Common: [], Uncommon: [], Rare: [], Mythic: [] };
  for (const n of POOL) byRarity[cards[n].rarity].push(n);
  const deck = [];
  for (const [rarity, count] of Object.entries(RARITY_COUNTS)) {
    deck.push(...shuffle(byRarity[rarity], rng).slice(0, count));
  }
  return shuffle(deck, rng);
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
