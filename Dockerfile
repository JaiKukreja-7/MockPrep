# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps
# Exact lockfile install, cached separately from the source so a code
# change does not reinstall everything.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build
# No .env files reach this stage (.dockerignore), so nothing is inlined:
# every variable, including the NEXT_PUBLIC_ pair, is read by the server at
# request time from the environment Cloud Run injects. The build itself
# needs none of them — every page that touches Supabase is dynamic.
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ----------------------------------------------------------------- run
# The standalone output only: server.js, the traced node_modules slice,
# plus the two directories standalone does not trace. Runs as the image's
# unprivileged node user.
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run sets PORT; the server must bind every interface, not localhost.
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 8080
CMD ["node", "server.js"]
