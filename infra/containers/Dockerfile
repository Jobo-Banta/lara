FROM node:24.16.0-bookworm-slim AS build
RUN npm install -g pnpm@9.15.5
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
COPY images/branding/ledger-l/web ./images/branding/ledger-l/web
RUN pnpm install --frozen-lockfile && pnpm build
FROM node:24.16.0-bookworm-slim AS runtime
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ARG BUILD_COMMIT=local-unreleased
ENV LARA_COMMIT=$BUILD_COMMIT
ENV NODE_ENV=production
USER node
FROM runtime AS api
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts/local-env.mjs ./scripts/local-env.mjs
COPY --from=build --chown=node:node /app/infra/certs ./infra/certs
CMD ["node","apps/api/src/server.mjs"]
FROM api AS worker
COPY --from=build --chown=node:node /app/apps/worker ./apps/worker
CMD ["node","apps/worker/src/main.mjs"]
FROM runtime AS web
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node","apps/web/server.js"]

# Single-service synthetic host: API stays on loopback; only Next.js is public.
FROM api AS demo-host
COPY --from=web --chown=node:node /app ./
COPY --from=build --chown=node:node /app/apps/worker ./apps/worker
COPY --from=build --chown=node:node /app/scripts/start-demo-host.mjs ./scripts/start-demo-host.mjs
EXPOSE 3000
CMD ["node","scripts/start-demo-host.mjs"]
