# Automaton runtime image (safe first-run profile).
#
# - Application code is owned by root and read-only to the agent user, so
#   edit_own_file / pull_upstream cannot change the running code.
# - No .git directory is shipped, so upstream update checks are a no-op.
# - All mutable state lives in /home/automaton/.automaton (mount a volume).

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY packages/cli ./packages/cli
RUN pnpm run build \
 && CI=true pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --create-home --home-dir /home/automaton --shell /usr/sbin/nologin automaton \
 && mkdir -p /home/automaton/.automaton \
 && chown automaton:automaton /home/automaton/.automaton \
 && chmod 700 /home/automaton/.automaton

WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/packages/cli/package.json ./packages/cli/
COPY --from=build /src/packages/cli/dist ./packages/cli/dist
COPY --from=build /src/packages/cli/node_modules ./packages/cli/node_modules
COPY constitution.md ./

# Fail-closed by default: turning safe mode off requires an explicit
# AUTOMATON_SAFE_MODE=0 override at run time.
ENV HOME=/home/automaton \
    NODE_ENV=production \
    AUTOMATON_SAFE_MODE=1
USER automaton
VOLUME ["/home/automaton/.automaton"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/index.js"]
# Harmless default: never start the agent loop implicitly.
CMD ["--help"]
