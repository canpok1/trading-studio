# 版は package.json の packageManager に合わせる
FROM oven/bun:1.3.11 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN bun install --frozen-lockfile --production
COPY packages/core/src packages/core/src
COPY packages/backend/src packages/backend/src
COPY packages/backend/drizzle packages/backend/drizzle
COPY --from=build /app/packages/frontend/dist packages/frontend/dist
# data/ は bind mount する。mini-pc の実行ユーザー（1000:1000）と揃え、マウントしないときも書き込めるようにしておく
RUN mkdir -p data && chown 1000:1000 data
USER 1000:1000
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["bun", "packages/backend/src/main.ts"]
