# HyperSight server: one bundled file plus the pairing page. Testnet only (the server refuses any
# other Hyperliquid URL). Secrets come from the runtime environment, never from the image.

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hypersight/server build && pnpm --filter @hypersight/link build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/hypersight.sqlite
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/link/dist apps/link/dist
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "apps/server/dist/index.js"]
