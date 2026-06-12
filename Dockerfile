# syntax=docker/dockerfile:1

# Build stage: install production deps. better-sqlite3 normally uses a prebuilt
# binary; the toolchain is only a fallback for platforms without one.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && rm -rf /var/lib/apt/lists/*

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
# scraped assets (data/cards.json, data/app.db, public/cards) come from volumes

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
