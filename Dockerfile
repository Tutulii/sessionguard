FROM node:24-alpine AS build
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S sessionguard && adduser -S -G sessionguard sessionguard
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=sessionguard:sessionguard /app/dist ./dist
COPY --from=build --chown=sessionguard:sessionguard /app/dist-server ./dist-server
COPY --from=build --chown=sessionguard:sessionguard /app/migrations ./migrations
USER sessionguard
EXPOSE 8080
CMD ["node", "--import", "./dist-server/server/instrumentation.js", "dist-server/server/index.js"]
