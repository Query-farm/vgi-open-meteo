FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Dependencies now come from npm (@query-farm/vgi, @query-farm/vgi-rpc), so the
# build is a plain install — no sibling vendoring or file: rewriting.
COPY package.json bun.lock /app/
RUN bun install --frozen-lockfile

COPY src /app/src
COPY tsconfig.json /app/tsconfig.json

FROM oven/bun:1.3-alpine

WORKDIR /app
COPY --from=builder /app /app

ARG GIT_COMMIT=unknown
ENV VGI_OPEN_METEO_GIT_COMMIT=${GIT_COMMIT}
ENV SENTRY_RELEASE=${GIT_COMMIT}

EXPOSE 8000
CMD ["bun", "run", "src/bin/serve.ts"]
