# RapidBooks in a container, for Linux machines whose own Node.js is too old
# (e.g. Linux Mint 19 / Ubuntu 18.04). Use deploy/docker-install.sh rather than
# running this by hand; see docs/DOCKER.md.
#
# The database, password hash, sessions, backups and SMTP settings all live in /data
# (a folder on the host), so the image can be rebuilt and replaced freely.

FROM node:24-bookworm-slim AS build
# Compilers, in case the SQLite driver has no prebuilt binary for this Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Dev dependencies are needed at run time too (tsx runs the server). If the web app was
# already built (docker-install.sh downloads it from GitHub, for CPUs that cannot run
# Vite's native bundler), it is used as it is.
RUN npm ci --no-audit --no-fund \
 && if [ -f packages/web/dist/index.html ]; then echo "Using the prebuilt web app"; else npm run build; fi

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    RAPIDBOOKS_DB=/data/rapidbooks.db \
    RAPIDBOOKS_SMTP_FILE=/data/smtp.json
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
