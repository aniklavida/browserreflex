# BrowserReflex MCP stdio server.
#
# Status: untested: written but never built or run.
#
# Only the MCP stdio server is packaged. The local REST API and web UI bind to
# 127.0.0.1 by design and are not reachable from outside a container.
#
# Run:  docker run -i --rm -v browserreflex-data:/data <image>
#
# Base image: node:22-slim only. No other image is used.

# ---- shared base: Node 22, pnpm through corepack, native build tools ----
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# better-sqlite3 is a native module; if no prebuilt binary matches, it is
# compiled with node-gyp, which needs python3, make and g++.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The pnpm version comes from "packageManager" in package.json.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install

# ---- build: full install, then compile every package ----
FROM base AS build
COPY packages ./packages
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm install --frozen-lockfile
RUN pnpm build
# The root build script covers the server and the UI; the CLI is built here.
RUN pnpm --filter=browserreflex-mcp run build

# ---- production dependencies only (UI excluded: it is not served in the container) ----
FROM base AS prod-deps
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/packs/package.json ./packages/packs/package.json
COPY packages/skill/package.json ./packages/skill/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm install --frozen-lockfile --prod --filter '!@browserreflex/ui'

# ---- runtime: production dependencies and compiled output only ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BROWSERREFLEX_HOME=/data

COPY --from=prod-deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps /app/packages/packs/node_modules ./packages/packs/node_modules

COPY --from=build /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
# The server finds packs/schema.json relative to its own compiled files, so the
# packs directory stays at packages/packs.
COPY --from=build /app/packages/packs ./packages/packs

# /data holds the SQLite file: <BROWSERREFLEX_HOME>/.browserreflex/browserreflex.db
# The built-in "node" user (uid 1000) runs the server.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

ENTRYPOINT ["node", "packages/cli/dist/bin.js", "serve"]
