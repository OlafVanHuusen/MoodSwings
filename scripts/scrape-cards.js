// Scrapes all Mood Swings card data + images from moodiest.app into local files
// for personal/local use. Run: npm run scrape
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const IMG_DIR = path.join(ROOT, "public", "cards");
const BASE = "https://moodiest.app";
const TOTAL = 134;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Strip HTML tags but render <span class="die">N</span> as [N] so value
// references inside rules text stay readable/parseable.
function htmlToText(html) {
  let s = html.replace(/<span class="die[^"]*">\s*([^<]*?)\s*<\/span>/g, "[$1]");
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function parseCard(html, num) {
  const get = (re, required = true) => {
    const m = html.match(re);
    if (!m) {
      if (required) throw new Error(`Card ${num}: pattern not found: ${re}`);
      return null;
    }
    return m[1];
  };

  const article = get(/<article class="card ([^"]*)">([\s\S]*?)<\/article>/, true);
  const colorClass = html.match(/<article class="card color-(\w+)"/)?.[1];
  const name = htmlToText(get(/<h2>\s*([\s\S]*?)\s*<\/h2>/));

  // Value block: one or two dice, e.g. <span class="die">3</span> or 3→7 or "?" / "X"
  const valueBlock = get(/<span class="value">\s*([\s\S]*?)\s*<\/span>\s*<\/header>/, false);
  const dice = valueBlock ? [...valueBlock.matchAll(/<span class="die[^"]*">\s*([^<]*?)\s*<\/span>/g)].map((m) => decodeEntities(m[1]).trim()) : [];

  const pills = [...html.matchAll(/<span class="pill([^"]*)">([\s\S]*?)<\/span>/g)].map((m) => ({
    cls: m[1].trim(),
    text: htmlToText(m[2]),
  }));
  const color = pills[0]?.text ?? null;
  const rarity = pills[1]?.text ?? null;
  const timings = pills.filter((p) => p.cls.includes("timing")).map((p) => p.text);

  const effectHtml = get(/<p class="effect">([\s\S]*?)<\/p>/, false);
  const effect = effectHtml ? htmlToText(effectHtml) : null;

  const notes = [];
  const notesBlock = html.match(/<details class="notes">([\s\S]*?)<\/details>/);
  if (notesBlock) {
    for (const m of notesBlock[1].matchAll(/<li>([\s\S]*?)<\/li>/g)) notes.push(htmlToText(m[1]));
  }

  const artist = htmlToText(get(/<footer class="card-foot">\s*<span>([\s\S]*?)<\/span>/, false) ?? "");
  const img = get(/<img class="card-art" src="([^"]+)"/, false);

  return {
    number: num,
    id: `MSW${String(num).padStart(4, "0")}`,
    name,
    color,
    colorClass,
    rarity,
    dice, // e.g. ["3"] or ["3","7"] or ["?"]
    timings,
    effect,
    notes,
    artist,
    image: img,
  };
}

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "personal-local-game-project" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function fetchBinary(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "personal-local-game-project" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(IMG_DIR, { recursive: true });

  const cards = [];
  for (let n = 1; n <= TOTAL; n++) {
    const html = await fetchText(`${BASE}/card/msw/${n}`);
    const card = parseCard(html, n);
    cards.push(card);

    if (card.image) {
      const fileName = path.basename(card.image);
      const dest = path.join(IMG_DIR, fileName);
      let exists = false;
      try {
        await access(dest);
        exists = true;
      } catch {}
      if (!exists) {
        const buf = await fetchBinary(`${BASE}${card.image}`);
        await writeFile(dest, buf);
      }
      card.image = `/cards/${fileName}`;
    }

    process.stdout.write(`\r${n}/${TOTAL} ${card.name}                    `);
    await sleep(DELAY_MS);
  }

  await writeFile(path.join(DATA_DIR, "cards.json"), JSON.stringify(cards, null, 2));
  console.log(`\nWrote ${cards.length} cards to data/cards.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
