# syntax=docker/dockerfile:1
# Multi-stage production image for DM Friend (Next.js standalone output).
# OPENAI_API_KEY is NOT needed to build; it is injected at runtime (k8s Secret).

ARG NODE_VERSION=22

# --- Stage 1: install dependencies from the lockfile ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- Stage 2: build the standalone server ---
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: minimal runtime ---
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as the unprivileged "node" user (uid/gid 1000) that ships with the base image.
# Standalone output omits public/ and .next/static, so copy them next to server.js.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
