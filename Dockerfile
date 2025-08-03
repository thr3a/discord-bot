FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY . ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

RUN npm run build


CMD ["npm", "run", "start"]
