# Vectis keeper as a long-running worker (no HTTP port). Build context: keeper/.
# No secrets at build time; all configuration comes from the runtime environment.
FROM node:22-slim

WORKDIR /app
RUN npm install -g pnpm@11.24.0 && npm cache clean --force

# tsx (a devDependency) runs the TypeScript entry point, so install everything.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json addresses.json ./
COPY src ./src

# node directly (not pnpm) so SIGTERM reaches the keeper's graceful shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
