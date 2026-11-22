# Yewholt daemon image. Pure JavaScript at runtime, so it is built once on the
# build platform and copied into each target platform's Node image.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/forge-z/yewholt" \
      org.opencontainers.image.description="Yewholt daemon"
ENV NODE_ENV=production YEWHOLT_HOME=/data
WORKDIR /app
COPY --from=build /app /app
RUN ln -s /app/dist/src/cli.js /usr/local/bin/yh \
  && mkdir -p /data /handoff && chown node:node /data /handoff
USER node
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
