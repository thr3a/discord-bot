FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

FROM base AS builder
COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules /app/node_modules
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build

FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["npm", "run", "start"]
