# Signaling server: long-running Node process (room registry + blind SDP/ICE relay).
# No media transits here. Built from the signaling/ context.
FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
EXPOSE 8080
CMD ["node", "src/index.js"]
