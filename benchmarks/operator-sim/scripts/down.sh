#!/usr/bin/env bash
# Thin glue for `make down`: everything is pinned to the kind context by src/infra/lifecycle.ts.
# KEEP_CLUSTER=1 keeps kind and removes only this repo's workloads/releases.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.bin:$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
pnpm exec tsx src/cli.ts down
# Worktree used for BetterDB buildRef images, if a build was interrupted.
git -C ../.. worktree remove --force .bin/betterdb-src 2>/dev/null || true
