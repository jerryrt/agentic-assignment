#!/usr/bin/env bash
# Run the browser suite inside the official Playwright image.
#
# WHY THIS EXISTS: font rasterisation differs between distributions, so a visual
# baseline captured on a laptop never matches one captured in CI.
# docs/02-browser-testing.md makes the container the only place a baseline may be
# produced or compared, and a rule that depends on someone remembering it is not
# a rule.  This script is the enforcement: it is the only supported way to run
# the visual project, and it is the same image CI uses.
#
# Usage, from the repository root:
#   apps/web/e2e/run-in-container.sh                    # the whole suite
#   apps/web/e2e/run-in-container.sh --project chromium
#   apps/web/e2e/run-in-container.sh --update-snapshots # regenerate baselines
#
# Prerequisites, both on the HOST:
#   supabase start   the stack the suite asserts against
#   pnpm dev         the app under test
#
# The container reuses this checkout's node_modules and installs nothing, and it
# has no pnpm of its own, so it cannot start the dev server itself: Playwright's
# webServer block reuses the one already listening on 4200 (--network host makes
# it visible).  Starting it on the host is therefore not optional here, which is
# the one ergonomic cost of running this way.

set -euo pipefail

# The image tag and the @playwright/test version in package.json must match
# exactly.  A browser build newer than the client speaks a protocol the client
# does not, and the failure is an unhelpful timeout rather than a version error.
PLAYWRIGHT_VERSION="1.62.1"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

installed="$(node -p "require('${REPO_ROOT}/node_modules/@playwright/test/package.json').version" 2>/dev/null || echo missing)"
if [ "${installed}" != "${PLAYWRIGHT_VERSION}" ]; then
  echo "playwright ${PLAYWRIGHT_VERSION} is not installed (found: ${installed})." >&2
  echo "Run: pnpm add -Dw @playwright/test@${PLAYWRIGHT_VERSION}" >&2
  exit 1
fi

# Mounted at its own absolute path, not at /work.  pnpm's node_modules is a tree
# of symlinks into .pnpm using absolute targets, so a checkout mounted anywhere
# else resolves to nothing and every import fails inside the container while
# working perfectly outside it.
#
# --network host: the suite talks to 127.0.0.1:54321 (Supabase) and
# 127.0.0.1:4200 (the dev server), both of which are on the host.
#
# --user: without it the container writes root-owned traces and baselines into
# the checkout, and the next run on the host cannot overwrite them.
#
# --ipc=host: Chromium's default 64 MB /dev/shm causes tab crashes that look
# exactly like flaky tests. This is Playwright's own documented recommendation.

# -t only when there is a terminal: in CI there is not, and asking for one fails.
tty_flags=()
if [ -t 1 ]; then tty_flags=(-it); fi

exec docker run --rm "${tty_flags[@]}" \
  --network host \
  --ipc=host \
  --user "$(id -u):$(id -g)" \
  --volume "${REPO_ROOT}:${REPO_ROOT}" \
  --workdir "${REPO_ROOT}" \
  --env HOME=/tmp \
  --env CI="${CI:-}" \
  --env E2E_BASE_URL="${E2E_BASE_URL:-}" \
  "${IMAGE}" \
  npx playwright test "$@"
