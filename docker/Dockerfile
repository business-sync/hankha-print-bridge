# The print bridge as a long-running service on an on-site box.
#
# Deliberately `node:22-slim` running the tsc output, NOT the `bun build --compile` binary the
# desktop installers ship. The app has ZERO runtime dependencies, so plain node is the smallest
# image with the fewest moving parts, and it sidesteps the glibc/musl target matrix a compiled
# binary would drag in for arm64 boxes.
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# devDependencies are needed here: `typescript` IS the build.
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY .env.example ./.env.example
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `.env.example` is a build-time FALLBACK for APP_VERSION, not a template to copy and edit —
# `loadEnv()` merges it first and lets real environment variables win. Omitting it makes the
# bridge report version 0.0.0-dev, which the POS then flags as "update the Print Bridge".
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.env.example ./.env.example
COPY package.json ./

# Bind every interface: inside a container 127.0.0.1 would be unreachable even from the host.
ENV PRINT_BRIDGE_HOST=0.0.0.0
ENV PRINT_BRIDGE_PORT=9200
ENV PRINT_BRIDGE_STATE_DIR=/var/lib/hankha-print-bridge

RUN mkdir -p /var/lib/hankha-print-bridge

EXPOSE 9200
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PRINT_BRIDGE_PORT||9200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
