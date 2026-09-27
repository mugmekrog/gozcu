# ------------------------------------------------------------------------------
# Frontend Multi-Stage Dockerfile (Firebase Hosting Target & Local Preview)
# ------------------------------------------------------------------------------
# Stages:
# 1. base: dependencies
# 2. dev: hot-reloading Vite dev server (for docker compose)
# 3. build: builds static production assets to /app/dist (for Firebase deploy)
# 4. preview: local preview of built static bundle
# ------------------------------------------------------------------------------

FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies with lockfile
COPY package*.json ./
RUN npm ci

# ------------------------------------------------------------------------------
# Dev stage (used in docker compose for local hot-reload)
# ------------------------------------------------------------------------------
FROM base AS dev

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# ------------------------------------------------------------------------------
# Build stage (builds static assets for Firebase Hosting)
# ------------------------------------------------------------------------------
FROM base AS build

# Build arg to set backend Cloud Run URL at build time
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ARG VITE_STT_URL
ENV VITE_STT_URL=${VITE_STT_URL}

COPY . .

# Run build outputting to /app/dist
RUN npm run build

# ------------------------------------------------------------------------------
# Preview stage (serves production bundle locally to test before Firebase deploy)
# ------------------------------------------------------------------------------
FROM base AS preview

WORKDIR /app

COPY --from=build /app/dist /app/dist

EXPOSE 5173

CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173", "--outDir", "dist"]
