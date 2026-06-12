// REST API: accounts, sessions, and saved decks.
import express from "express";
import {
  ApiError,
  checkLogin,
  createDeck,
  createSession,
  createUser,
  deleteDeck,
  destroySession,
  listDecks,
  updateDeck,
  userForSession,
} from "./db.js";
import { POOL, publicCard } from "./gamedata.js";
import { config } from "./config.js";
import { rateLimit } from "./security.js";

const SESSION_COOKIE = "msw_session";

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionUser(cookieHeader) {
  return userForSession(parseCookies(cookieHeader)[SESSION_COOKIE]);
}

export const api = express.Router();
api.use(express.json({ limit: "100kb" }));

api.use((req, res, next) => {
  req.sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  req.user = userForSession(req.sessionId);
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not logged in." });
  next();
}

function setSessionCookie(res, sessionId, maxAge = 60 * 60 * 24 * config.sessionTtlDays) {
  const secure = config.cookieSecure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

// shared window: registration + failed logins both count against it
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

api.post("/register", authLimiter, (req, res) => {
  const user = createUser(req.body?.username, req.body?.password);
  setSessionCookie(res, createSession(user.id));
  res.json({ user });
});

api.post("/login", authLimiter, (req, res) => {
  const user = checkLogin(req.body?.username, req.body?.password);
  if (!user) return res.status(401).json({ error: "Wrong username or password." });
  setSessionCookie(res, createSession(user.id));
  res.json({ user });
});

api.post("/logout", (req, res) => {
  if (req.sessionId) destroySession(req.sessionId);
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
});

api.get("/me", (req, res) => {
  res.json({ user: req.user });
});

// public card catalog for the deck builder
api.get("/cards", (req, res) => {
  res.json({ cards: POOL.map(publicCard) });
});

api.get("/decks", requireAuth, (req, res) => {
  res.json({ decks: listDecks(req.user.id) });
});

api.post("/decks", requireAuth, (req, res) => {
  res.json({ deck: createDeck(req.user.id, req.body?.name, req.body?.cards ?? []) });
});

api.put("/decks/:id", requireAuth, (req, res) => {
  res.json({ deck: updateDeck(req.user.id, Number(req.params.id), req.body?.name, req.body?.cards) });
});

api.delete("/decks/:id", requireAuth, (req, res) => {
  deleteDeck(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// error handler (ApiError -> clean 4xx)
api.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  console.error("API error:", err);
  res.status(500).json({ error: "Internal error." });
});
