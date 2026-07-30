# syntax=docker/dockerfile:1
#
# Production image for the LoPay NestJS backend. Host-agnostic — used by Render
# (Docker runtime) and runnable anywhere Docker is available. `prisma generate`
# runs in the build stage so the client matches the build host. Debian slim (not
# Alpine) is used because Prisma's engines are happiest with glibc + OpenSSL.

# ---- Stage 1: build ---------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Prisma's engines need OpenSSL present at generate time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies (including dev). The Nest CLI and TypeScript live in
# devDependencies, so `--include=dev` is required even though the image is prod.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Generate the Prisma client into src/generated, then compile TS -> dist/.
COPY . .
RUN npx prisma generate && npm run build

# Drop dev dependencies now the build is done. Keeps @prisma/client, the prisma
# CLI (needed for `migrate deploy`), pg, dotenv, etc.
RUN npm prune --omit=dev

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the pruned deps, the compiled app, and the files that
# `prisma migrate deploy` needs at boot (schema, migrations, prisma.config.ts).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json ./package.json

# Run as the unprivileged `node` user that ships with the base image.
USER node

EXPOSE 3001

# Apply any pending migrations, then boot the API. Mirrors the previous Railway
# start command. If migrations fail the container exits non-zero and Compose's
# restart policy retries — the app never starts against an un-migrated schema.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
