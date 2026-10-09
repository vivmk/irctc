FROM node:20-slim
WORKDIR /app
RUN corepack enable

# copy only dependency lists first, so reinstalls are skipped when only code changed
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile

# now copy the actual code
COPY tsconfig.base.json ./
COPY apps/backend apps/backend
COPY packages/shared-types packages/shared-types

CMD ["pnpm", "--filter", "@irctc/backend", "start"]