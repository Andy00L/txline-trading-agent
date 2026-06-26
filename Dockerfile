# syntax=docker/dockerfile:1

# Build and run the headless TxLINE odds-trading agent (the @txline-agent/api process, which
# boots the agent runtime and serves its read-only state). Secrets are never baked in: provide
# the TxLINE token and Solana config at run time with --env-file and mount the wallet keypair
# read-only. sourceRef: docs/runbooks/M6-agent.md.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=8080
COPY --from=build /app ./
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.API_PORT||8080)+'/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/api/dist/main.js"]
