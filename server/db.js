// SQLite persistence: user accounts, login sessions, and saved decks.
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POOL } from "./gamedata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "..", "data", "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cards TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- auth ----

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString("hex");
}

export function createUser(username, password) {
  username = String(username || "").trim();
  if (!/^[\w-]{2,20}$/.test(username)) {
    throw new ApiError("Username must be 2–20 letters, digits, _ or -.");
  }
  if (typeof password !== "string" || password.length < 4) {
    throw new ApiError("Password must be at least 4 characters.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const r = db
      .prepare("INSERT INTO users (username, pass_hash, salt) VALUES (?, ?, ?)")
      .run(username, hashPassword(password, salt), salt);
    return { id: r.lastInsertRowid, username };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new ApiError("That username is taken.");
    throw e;
  }
}

export function checkLogin(username, password) {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
  if (!row) return null;
  const hash = hashPassword(String(password ?? ""), row.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.pass_hash));
  return ok ? { id: row.id, username: row.username } : null;
}

export function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(id, userId);
  return id;
}

export function destroySession(sessionId) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function userForSession(sessionId) {
  if (!sessionId) return null;
  const row = db
    .prepare(
      "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?"
    )
    .get(sessionId);
  return row || null;
}

// ---- decks ----
// A deck is a list of card numbers; duplicates are allowed and there are no
// size restrictions at save time (formats are enforced at game start instead).

export function normalizeDeckCards(cardsIn) {
  if (!Array.isArray(cardsIn)) throw new ApiError("Deck cards must be an array of card numbers.");
  if (cardsIn.length > 500) throw new ApiError("Deck is too large (max 500 cards).");
  const nums = cardsIn.map(Number);
  if (!nums.every((n) => POOL.includes(n))) throw new ApiError("Deck contains unknown card numbers.");
  return nums;
}

function deckRow(r) {
  return { id: r.id, name: r.name, cards: JSON.parse(r.cards), updatedAt: r.updated_at };
}

export function listDecks(userId) {
  return db
    .prepare("SELECT * FROM decks WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId)
    .map(deckRow);
}

export function getDeck(userId, deckId) {
  const r = db.prepare("SELECT * FROM decks WHERE id = ? AND user_id = ?").get(deckId, userId);
  return r ? deckRow(r) : null;
}

export function createDeck(userId, name, cardsIn) {
  name = String(name || "").trim().slice(0, 40) || "Untitled deck";
  const nums = normalizeDeckCards(cardsIn);
  const r = db
    .prepare("INSERT INTO decks (user_id, name, cards) VALUES (?, ?, ?)")
    .run(userId, name, JSON.stringify(nums));
  return getDeck(userId, r.lastInsertRowid);
}

export function updateDeck(userId, deckId, name, cardsIn) {
  const existing = getDeck(userId, deckId);
  if (!existing) throw new ApiError("Deck not found.", 404);
  name = String(name ?? existing.name).trim().slice(0, 40) || existing.name;
  const nums = cardsIn != null ? normalizeDeckCards(cardsIn) : existing.cards;
  db.prepare("UPDATE decks SET name = ?, cards = ?, updated_at = datetime('now') WHERE id = ?").run(
    name,
    JSON.stringify(nums),
    deckId
  );
  return getDeck(userId, deckId);
}

export function deleteDeck(userId, deckId) {
  db.prepare("DELETE FROM decks WHERE id = ? AND user_id = ?").run(deckId, userId);
}

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
