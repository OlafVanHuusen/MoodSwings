// Security middleware: response headers and a small in-memory rate limiter.
// Deliberately dependency-free — the needs here are modest (home server scale).

// All scripts/styles are same-origin files except Google Fonts; websockets
// connect back to the same host. No inline <script> anywhere (CSP enforces it).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

/**
 * Fixed-window per-IP rate limiter for sensitive endpoints (login/register).
 * Window state lives in memory; fine for a single-process deployment.
 */
export function rateLimit({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map(); // ip -> {count, windowStart}
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, h] of hits) if (h.windowStart < cutoff) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "?";
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.windowStart >= windowMs) {
      h = { count: 0, windowStart: now };
      hits.set(ip, h);
    }
    if (++h.count > max) {
      res.setHeader("Retry-After", Math.ceil((h.windowStart + windowMs - now) / 1000));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}
