# syntax=docker/dockerfile:1

# AppZex API image.
# Suitable for any Docker-based host: Render, Railway, Fly.io, ECS, or a plain `docker run`.
# The web app is deployed separately (see vercel.json); this image serves /api/v1 only.
#
# The Next.js /api/v1 rewrite is baked at *web build* time, not at runtime, so
# `API_INTERNAL_URL` is a build variable for the web app and a run-time variable for this image.
#
# Build:  docker build -t appzex-api .
# Run:    docker run -p 4000:4000 --env-file .env.local appzex-api

FROM node:24-alpine AS builder
WORKDIR /app

# The Prisma client is generated into the hoisted root node_modules and the `prisma` CLI is a
# devDependency, so the run-time stage reuses the full install instead of pruning it.
# Schema and migrations are copied *after* install, so suppress the client's postinstall
# auto-generate here and run it explicitly below.
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=1

# Both workspace manifests are required for `npm ci` to resolve the workspace graph.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
COPY apps/api ./apps/api

RUN npx prisma generate --schema prisma/schema.prisma
RUN npm run build --workspace @appzex/api


FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# openssl provides the TLS backend the Prisma query engine links against.
RUN apk add --no-cache openssl

# Copy the full dependency tree so the generated Prisma client and the `prisma` CLI used by the
# migration step both stay available. The workspace symlinks under node_modules resolve because
# apps/api is copied alongside them. This image is intentionally not size-optimised: correct
# client resolution and `migrate deploy` are preferred over a smaller layer.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Uploads live on a mounted volume in production; the directory must exist and be writable
# by the unprivileged user.
RUN mkdir -p /app/private-uploads && chown -R node:node /app

USER node
EXPOSE 4000

# Liveness only: the health route does not perform a database round trip, so a database
# outage does not cause the orchestrator to kill an otherwise healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations, then start. `migrate deploy` is forward-only: it applies committed
# migrations and never drops, truncates, or resets data.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node apps/api/dist/server.js"]
