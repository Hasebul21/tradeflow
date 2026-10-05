# The Tradeflow app with its synthetic data. Postgres is not needed to run it.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# next/font downloads Source Sans 3 and Source Serif 4 here, at build time, so the running app makes no font request.
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD npx next start -H 0.0.0.0 -p ${PORT:-3000}
