# Một Dockerfile, hai đích: "api" (backend Fastify) và "web" (frontend Next.js)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

FROM deps AS api
WORKDIR /app
COPY server server
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "server/src/index.ts"]

FROM deps AS web-build
WORKDIR /app
COPY web web
# Địa chỉ backend được gắn vào mã giao diện lúc build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w web

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build /app/web/.next/standalone ./
COPY --from=web-build /app/web/.next/static ./web/.next/static
COPY --from=web-build /app/web/public ./web/public
EXPOSE 3000
CMD ["node", "web/server.js"]
