// Express + Socket.IO server: lobby management and game session relay.
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Game } from "./engine/game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/game/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "game.html"));
});

// ---- lobby state ----
// code -> { code, hostName, playerCount, deckMode, players: [{token, name, seat, socket}], game, started }
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
      deckMode: r.deckMode,
    }));
}

function broadcastLobby() {
  io.to("lobby").emit("lobbyList", lobbyList());
}

function roomState(room) {
  return {
    code: room.code,
    playerCount: room.playerCount,
    deckMode: room.deckMode,
    started: room.started,
    players: room.players.map((p) => ({ name: p.name, seat: p.seat, connected: !!p.socket })),
  };
}

function pushGame(room) {
  for (const p of room.players) {
    if (p.socket) p.socket.emit("gameState", room.game.stateFor(p.seat));
  }
}

function startGame(room) {
  room.started = true;
  room.game = new Game({
    playerCount: room.playerCount,
    deckMode: room.deckMode,
    onUpdate: () => pushGame(room),
    onLog: () => pushGame(room),
    onGameOver: () => pushGame(room),
  });
  for (const p of room.players) p.seat = room.game.addPlayer(p.name);
  for (const p of room.players) {
    if (p.socket) p.socket.emit("gameStarted", { code: room.code, token: p.token });
  }
  broadcastLobby();
  room.game.start();
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

io.on("connection", (socket) => {
  socket.on("enterLobby", () => {
    socket.join("lobby");
    socket.emit("lobbyList", lobbyList());
  });

  socket.on("createGame", ({ name, playerCount, deckMode }, cb) => {
    dropFromWaitingRoom(socket);
    name = String(name || "").trim().slice(0, 20) || "Player";
    playerCount = Math.min(4, Math.max(2, Number(playerCount) || 2));
    deckMode = deckMode === "full" ? "full" : "random45";
    const code = genCode();
    const token = crypto.randomUUID();
    const room = {
      code,
      playerCount,
      deckMode,
      players: [{ token, name, seat: 0, socket }],
      game: null,
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

  socket.on("joinGame", ({ code, name }, cb) => {
    dropFromWaitingRoom(socket);
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Game not found." });
    if (room.started) return cb?.({ ok: false, error: "Game already started." });
    if (room.players.length >= room.playerCount) return cb?.({ ok: false, error: "Game is full." });
    name = String(name || "").trim().slice(0, 20) || `Player ${room.players.length + 1}`;
    const token = crypto.randomUUID();
    room.players.push({ token, name, seat: room.players.length, socket });
    socket.data.room = room;
    socket.data.token = token;
    socket.join(`room:${room.code}`);
    cb?.({ ok: true, code: room.code, token });
    io.to(`room:${room.code}`).emit("roomState", roomState(room));
    broadcastLobby();
    if (room.players.length === room.playerCount) startGame(room);
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
      socket.emit("gameState", room.game.stateFor(player.seat));
    } else {
      io.to(`room:${room.code}`).emit("roomState", roomState(room));
    }
  });

  socket.on("promptAnswer", (answer) => {
    const room = socket.data.room;
    if (!room?.game) return;
    const player = room.players.find((p) => p.token === socket.data.token);
    if (!player) return;
    const ok = room.game.answerPrompt(player.seat, answer);
    if (!ok) socket.emit("gameState", room.game.stateFor(player.seat)); // resync on bad answer
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
