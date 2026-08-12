# Signaling server: long-running Node process (room registry + blind SDP/ICE relay).
# No media transits here. Built from the signaling/ context.
# Pinned by digest for the same reason as the web Dockerfile — see the note there. Keep the two in
# step: they are the same base image.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
EXPOSE 8080
# Drop root: the runtime only reads its files and binds 8080 (>1024). The node image ships this user.
USER node
CMD ["node", "src/index.js"]
