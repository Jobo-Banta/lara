FROM node:24.16.0-bookworm-slim
RUN npm install -g pnpm@9.15.5
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
COPY images/branding/ledger-l/web ./images/branding/ledger-l/web
RUN pnpm install --frozen-lockfile && pnpm build
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0"]
