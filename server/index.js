// HTTP + Socket.IO wiring: static files, REST API, session auth on sockets,
// and the lobby. Room/match logic lives in lobby.js.
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { api, sessionUser } from "./api.js";
import { closeDb, purgeExpiredSessions } from "./db.js";
import { attachLobby } from "./lobby.js";
import { securityHeaders } from "./security.js";
import { config } from "./config.js";

const app = express();
const http = createServer(app);
const io = new Server(http);

app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);
app.use(securityHeaders);

// card scans never change once scraped — let browsers cache them hard
app.use(
  express.static(config.publicDir, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}cards${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
      }
    },
  })
);
app.use("/api", api);
app.get("/game/:code", (req, res) => {
  res.sendFile(path.join(config.publicDir, "game.html"));
});
app.get("/decks", (req, res) => {
  res.sendFile(path.join(config.publicDir, "decks.html"));
});
app.get("/healthz", (req, res) => {
  res.json({ ok: true, rooms: lobby.roomCount() });
});

io.use((socket, next) => {
  socket.data.user = sessionUser(socket.request.headers.cookie);
  next();
});
const lobby = attachLobby(io);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000).unref();

http.listen(config.port, () => {
  console.log(`Mood Swings running at http://localhost:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  lobby.stop();
  io.close(); // also closes the underlying http server
  closeDb();
  // sockets keep the loop alive briefly; force-exit if close hangs
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
