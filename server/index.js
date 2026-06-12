// Express + Socket.IO server: auth/deck API, lobby management, match relay.
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { api, sessionUser } from "./api.js";
import { getDeck } from "./db.js";
import { Match, MODES, deckProblem } from "./match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", api);
app.get("/game/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "game.html"));
});
app.get("/decks", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "decks.html"));
});

// ---- lobby state ----
// code -> { code, mode, playerCount, deckMode, players: [{token, name, seat, socket,
//           userId, deckCards}], match, started }
const rooms = new Map();

function genCode() {
  let code;
  do {
    code = crypto.randomBytes(2).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function lobbyList() {
  return [...rooms.values()]
    .filter((r) => !r.started)
    .map((r) => ({
      code: r.code,
      hostName: r.players[0]?.name ?? "?",
      playerCount: r.playerCount,
      joined: r.players.length,
      mode: r.mode,
      modeLabel: MODES[r.mode].label,
      deckMode: r.deckMode,
      needsAuth: MODES[r.mode].auth,
      needsDeck: MODES[r.mode].kind === "duel",
    }));
}

function broadcastLobby() {
  io.to("lobby").emit("lobbyList", lobbyList());
}

function roomState(room) {
  return {
    code: room.code,
    mode: room.mode,
    modeLabel: MODES[room.mode].label,
    playerCount: room.playerCount,
    deckMode: room.deckMode,
    started: room.started,
    teams: MODES[room.mode].kind === "team",
    teamPattern: room.mode === "team-open" ? "adjacent" : room.mode === "team-closed" ? "across" : null,
    players: room.players.map((p) => ({ name: p.name, seat: p.seat, connected: !!p.socket })),
  };
}

function pushMatch(room) {
  for (const p of room.players) {
    if (!p.socket) continue;
    p.socket.emit("matchState", room.match.stateFor(p.seat));
    if (room.match.game) p.socket.emit("gameState", room.match.game.stateFor(p.seat));
  }
}

function startMatch(room) {
  room.started = true;
  room.match = new Match({
    mode: room.mode,
    playerCount: room.playerCount,
    deckMode: room.deckMode,
    players: room.players.map((p) => ({ seat: p.seat, name: p.name, deckCards: p.deckCards })),
    onUpdate: () => pushMatch(room),
  });
  for (const p of room.players) {
    if (p.socket) p.socket.emit("gameStarted", { code: room.code, token: p.token });
  }
  broadcastLobby();
  room.match.start();
}

/** Remove a socket's player from its current un-started room (if any). */
function dropFromWaitingRoom(socket) {
  const room = socket.data.room;
  if (!room || room.started) return;
  const idx = room.players.findIndex((p) => p.token === socket.data.token);
  if (idx >= 0) {
    room.players.splice(idx, 1);
    room.players.forEach((p, i) => (p.seat = i));
  }
  socket.leave(`room:${room.code}`);
  socket.data.room = null;
  if (!room.players.length) rooms.delete(room.code);
  else io.to(`room:${room.code}`).emit("roomState", roomState(room));
  broadcastLobby();
}

/** Resolve and validate the deck a logged-in player brings to a duel room. */
function resolveDeck(mode, user, deckId) {
  if (MODES[mode].kind !== "duel") return { deckCards: null };
  const deck = getDeck(user.id, Number(deckId));
  if (!deck) return { error: "Pick one of your decks for this format." };
  const problem = deckProblem(mode, deck.cards);
  if (problem) return { error: problem };
  return { deckCards: deck.cards };
}

io.use((socket, next) => {
  socket.data.user = sessionUser(socket.request.headers.cookie);
  next();
});

io.on("connection", (socket) => {
  socket.on("enterLobby", () => {
    socket.join("lobby");
    socket.emit("lobbyList", lobbyList());
  });

  socket.on("createGame", ({ name, mode, playerCount, deckMode, deckId }, cb) => {
    dropFromWaitingRoom(socket);
    mode = MODES[mode] ? mode : "classic";
    const def = MODES[mode];
    const user = socket.data.user;
    if (def.auth && !user) return cb?.({ ok: false, error: "Log in to play this mode." });
    name = String(name || user?.username || "").trim().slice(0, 20) || "Player";
    playerCount = def.players.includes(Number(playerCount)) ? Number(playerCount) : def.players[0];
    deckMode = deckMode === "full" ? "full" : "random45";
    const { deckCards, error } = resolveDeck(mode, user, deckId);
    if (error) return cb?.({ ok: false, error });
    const code = genCode();
    const token = crypto.randomUUID();
    const room = {
      code,
      mode,
      playerCount,
      deckMode,
      players: [{ token, name, seat: 0, socket, userId: user?.id ?? null, deckCards }],
      match: null,
      started: false,
    };
    rooms.set(code, room);
    socket.data.room = room;
    socket.data.token = token;
    socket.join(`room:${code}`);
    cb?.({ ok: true, code, token });
    io.to(`room:${code}`).emit("roomState", roomState(room));
    broadcastLobby();
  });

  socket.on("joinGame", ({ code, name, deckId }, cb) => {
    dropFromWaitingRoom(socket);
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Game not found." });
    if (room.started) return cb?.({ ok: false, error: "Game already started." });
    if (room.players.length >= room.playerCount) return cb?.({ ok: false, error: "Game is full." });
    const def = MODES[room.mode];
    const user = socket.data.user;
    if (def.auth && !user) return cb?.({ ok: false, error: "Log in to play this mode." });
    const { deckCards, error } = resolveDeck(room.mode, user, deckId);
    if (error) return cb?.({ ok: false, error });
    name =
      String(name || user?.username || "").trim().slice(0, 20) || `Player ${room.players.length + 1}`;
    const token = crypto.randomUUID();
    room.players.push({
      token,
      name,
      seat: room.players.length,
      socket,
      userId: user?.id ?? null,
      deckCards,
    });
    socket.data.room = room;
    socket.data.token = token;
    socket.join(`room:${room.code}`);
    cb?.({ ok: true, code: room.code, token });
    io.to(`room:${room.code}`).emit("roomState", roomState(room));
    broadcastLobby();
    if (room.players.length === room.playerCount) startMatch(room);
  });

  // game page (re)connect: client supplies room code + player token
  socket.on("attach", ({ code, token }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Game not found." });
    const player = room.players.find((p) => p.token === token);
    if (!player) return cb?.({ ok: false, error: "You are not part of this game." });
    player.socket = socket;
    socket.data.room = room;
    socket.data.token = token;
    socket.join(`room:${room.code}`);
    cb?.({ ok: true, seat: player.seat, started: room.started });
    if (room.started) {
      socket.emit("matchState", room.match.stateFor(player.seat));
      if (room.match.game) socket.emit("gameState", room.match.game.stateFor(player.seat));
    } else {
      io.to(`room:${room.code}`).emit("roomState", roomState(room));
    }
  });

  socket.on("promptAnswer", (answer) => {
    const room = socket.data.room;
    if (!room?.match) return;
    const player = room.players.find((p) => p.token === socket.data.token);
    if (!player) return;
    const ok = room.match.answer(player.seat, answer);
    if (!ok) {
      // resync on bad answer
      socket.emit("matchState", room.match.stateFor(player.seat));
      if (room.match.game) socket.emit("gameState", room.match.game.stateFor(player.seat));
    }
  });

  socket.on("leaveRoom", () => dropFromWaitingRoom(socket));

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room) return;
    const player = room.players.find((p) => p.token === socket.data.token);
    if (player && player.socket === socket) player.socket = null;
    if (!room.started) dropFromWaitingRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Mood Swings running at http://localhost:${PORT}`);
});
