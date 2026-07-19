FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HOST=0.0.0.0
ENV PORT=4310
ENV DATA_DIR=/data
ENV PUBLIC_BASE_URL=http://localhost:4310

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY apps/server/package.json apps/server/tsconfig.json apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production

RUN mkdir -p /data/assets /data/renders && chown -R pwuser:pwuser /app /data

USER pwuser

EXPOSE 4310
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail http://127.0.0.1:4310/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
