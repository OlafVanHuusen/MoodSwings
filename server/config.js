// Central runtime configuration. Everything tunable at deploy time reads from
// environment variables here, with defaults that match local development.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const config = {
  port: Number(process.env.PORT) || 3000,

  // Where cards.json and app.db live; a Docker volume mounts over this.
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  publicDir: path.join(ROOT, "public"),

  // Set when serving over HTTPS (e.g. behind a reverse proxy) so the session
  // cookie gets the Secure flag. TRUST_PROXY makes Express/rate limiting read
  // client IPs from X-Forwarded-For — only set it when a proxy is in front.
  cookieSecure: process.env.COOKIE_SECURE === "1",
  trustProxy: process.env.TRUST_PROXY === "1",

  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS) || 365,

  // Lobby limits: cap concurrent rooms (cheap DoS guard) and reap rooms whose
  // match has ended or whose players have all disconnected.
  maxRooms: Number(process.env.MAX_ROOMS) || 200,
  roomReapMinutes: Number(process.env.ROOM_REAP_MINUTES) || 60,
};
