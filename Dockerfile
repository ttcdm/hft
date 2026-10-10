# Multi-stage production Dockerfile for Apex Quant HFT Workstation
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native bindings if required
RUN apk add --no-cache python3 make g++

# Copy package manifests first to leverage Docker layer caching
COPY package.json package-lock.json ./
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
ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    ALLOW_PUBLIC_BIND=true \
    APEX_CONTAINER=true \
    ALLOWED_CLUSTER=devnet

# Install runtime utilities
RUN apk add --no-cache curl wget

# Copy package manifests and production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built distribution bundles from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.env.example ./.env.example

# Create non-root user and set permissions
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist/server.cjs"]
