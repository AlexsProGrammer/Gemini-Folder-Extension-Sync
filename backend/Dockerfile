FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY drizzle.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev \
    && apk del python3 make g++
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]