# Multi-stage production Dockerfile for Apex Quant HFT Workstation
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native bindings if required
RUN apk add --no-cache python3 make g++

# Copy package manifests first to leverage Docker layer caching. npm ci runs the postinstall script (scripts/patch-anchor.cjs), so that
# one file has to be in the image before it; without it the build stops with "Cannot find module '/app/scripts/patch-anchor.cjs'".
COPY package.json package-lock.json ./
COPY scripts/patch-anchor.cjs ./scripts/
RUN npm ci

# Copy full application source
COPY . .

# Compile frontend and backend bundles
ENV NODE_ENV=production
RUN npm run build

# Production runner image
FROM node:22-alpine AS runner

WORKDIR /app

# Inside the container the app must listen on all interfaces for the published port to work; docker-compose.yml publishes it on
# the host's loopback only. APEX_CONTAINER stops the generated operator token being printed into container logs.
# Everything the app writes lives under /app/data, which docker-compose.yml mounts as a named volume so it survives
# `docker compose down` and rebuilds: the SQLite database with its -wal/-shm files, and the signing key file if one is
# generated or imported from the UI (otherwise a key holding devnet SOL would be lost with the container). No key is in the image.
ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    ALLOW_PUBLIC_BIND=true \
    APEX_CONTAINER=true \
    ALLOWED_CLUSTER=devnet \
    APEX_DB_PATH=/app/data/apex_workstation.db \
    SIGNER_KEYPAIR_PATH=/app/data/.apex_trading_keypair.json

# Install runtime utilities
RUN apk add --no-cache curl wget

# Copy package manifests and production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built distribution bundles from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.env.example ./.env.example

# Create non-root user and set permissions. The data directory is created here, owned by node and closed to others, so a fresh
# named volume mounted over it starts with the same owner and mode.
RUN mkdir -p /app/data && chown -R node:node /app && chmod 700 /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist/server.cjs"]
