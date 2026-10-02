# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

WORKDIR /app
ENV NODE_ENV=production

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Operational image for one-shot and background jobs (migrations, first-admin
# bootstrap, outbox worker). These are TypeScript entrypoints executed by tsx,
# so this stage keeps the full dependency tree and the server sources; the web
# runner below stays minimal. Build with `--target ops`.
FROM dependencies AS ops

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node packages ./packages
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

USER node

CMD ["node_modules/.bin/tsx", "scripts/outbox-worker.ts"]

FROM node:22-bookworm-slim AS runner

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
  CMD ["node", "-e", "const headers = {'x-cvg-proxy-secret': process.env.TRUST_PROXY_SHARED_SECRET ?? '', 'x-forwarded-for': '127.0.0.1'}; Promise.all(['/api/v1/livez', '/api/v1/readyz'].map(async path => { const response = await fetch('http://127.0.0.1:3000' + path, {headers}); if (!response.ok) throw new Error(path + ':' + response.status); })).catch(() => process.exit(1))"]

CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
