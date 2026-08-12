# Web front (static Astro build served by nginx). Signaling has its own Dockerfile.
#
# Base images are pinned by DIGEST, not just by tag. `node:24-alpine` and `nginx:stable-alpine` are
# moving targets: the same commit rebuilt a week later produced a different image, which for a
# pipeline that only runs on a version tag means the one build that ships is not reproducible. The
# tag is kept alongside the digest purely as a human-readable label — the digest is what resolves.
# Bump with `docker buildx imagetools inspect <image>:<tag>` (or let Renovate/Dependabot do it).
# Stage 1 — build
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Stage 2 — serve
FROM nginx:stable-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
