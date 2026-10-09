# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

# The published Node image can lag behind Debian security updates (libpcre2,
# perl-base, ...). Apply every pending upgrade instead of chasing single
# packages, so the image gate does not fail each time Debian ships a fix.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade --yes --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY vendor/fast-glob-3.3.1-cvg.1.tgz ./vendor/
RUN npm ci

FROM dependencies AS builder

WORKDIR /app
ENV NODE_ENV=production

COPY . .
RUN npm run build

FROM base AS production-dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY vendor/fast-glob-3.3.1-cvg.1.tgz ./vendor/
# Playwright is "devOptional" (an optional peer of next), so --omit=dev keeps
# it. Next only loads it from its experimental test mode, never at runtime.
RUN npm ci --omit=dev \
    && rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core \
      node_modules/.bin/playwright node_modules/.bin/playwright-core \
    && npm cache clean --force

# Operational image for one-shot and background jobs (migrations, first-admin
# bootstrap, outbox worker). These are TypeScript entrypoints executed by tsx,
# so this stage keeps the full dependency tree and the server sources; the web
# runner below stays minimal. Build with `--target ops`.
FROM dependencies AS ops

WORKDIR /app
ENV NODE_ENV=production

# Operations use npm run; retain a patched CLI instead of the vulnerable
# bundled npm. Runtime application dependencies still come from the lockfile.
# Published npm 11/12 still bundle vulnerable patch versions; update only those
# bundled dependencies, within their existing major versions (D-027).
RUN npm install --global npm@11.21.0 \
    && npm install --prefix /tmp/npm-cli-security \
      --omit=dev --ignore-scripts --no-package-lock \
      brace-expansion@5.0.11 undici@6.28.1 \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/undici \
    && cp -a /tmp/npm-cli-security/node_modules/. /usr/local/lib/node_modules/npm/node_modules/ \
    && rm -rf /tmp/npm-cli-security \
    && npm cache clean --force

COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node packages ./packages
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

USER node

CMD ["node_modules/.bin/tsx", "scripts/outbox-worker.ts"]

FROM base AS runner

WORKDIR /app

# This project uses the standard Next.js production server rather than
# output: standalone, so the runtime keeps only production dependencies and
# the completed .next bundle.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=node:node /app/package.json ./package.json

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && mkdir -p .data/uploads \
    && chown -R node:node .data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "const secret = process.env.TRUST_PROXY_SHARED_SECRET || (process.env.TRUST_PROXY_SHARED_SECRET_FILE ? require('fs').readFileSync(process.env.TRUST_PROXY_SHARED_SECRET_FILE, 'utf8').replace(/\\r?\\n$/, '') : ''); const headers = {'x-cvg-proxy-secret': secret, 'x-forwarded-for': '127.0.0.1'}; Promise.all(['/api/v1/livez', '/api/v1/readyz'].map(async path => { const response = await fetch('http://127.0.0.1:3000' + path, {headers}); if (!response.ok) throw new Error(path + ':' + response.status); })).catch(() => process.exit(1))"]

CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
