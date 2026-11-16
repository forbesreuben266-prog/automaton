# Build from the repo root:  docker build -f packages/tenderscout/Dockerfile -t tenderscout .
FROM node:22-slim
WORKDIR /app/packages/tenderscout
COPY packages/tenderscout/package.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
 && npm install && npm cache clean --force
COPY packages/tenderscout/tsconfig.json ./
COPY packages/tenderscout/src ./src
RUN npx tsc && npm prune --omit=dev
ENV TS_DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/cli.js", "start"]
