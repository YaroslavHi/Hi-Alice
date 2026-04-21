# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Remove dev dependencies after build.
RUN npm prune --production

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security.
RUN addgroup -S alice && adduser -S alice -G alice

WORKDIR /app

# Copy only what's needed.
COPY --from=builder /build/dist        ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY src/db/schema.sql                 ./src/db/schema.sql
COPY scripts/                          ./scripts/

USER alice

# Health check — matches Yandex Smart Home spec endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/v1.0 || exit 1

EXPOSE 3000

CMD ["node", "dist/index.js"]
