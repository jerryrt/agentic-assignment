#!/bin/sh
#
# Emit (or verify) the generated migration that seeds workflow_transition.
#
#   sh tools/generate-transitions.sh write   # pnpm workflow:gen
#   sh tools/generate-transitions.sh check   # pnpm workflow:check
#
# Why this is a shell script and not TypeScript
# --------------------------------------------
# packages/workflow is a pure package. It may not import node:fs -- the ESLint
# layering rule enforces that, because a pure package able to reach the
# filesystem is one refactor away from a guard doing the same, and the browser
# and the server would stop running byte-identical logic. Rendering the SQL is
# therefore pure TypeScript that prints to standard output, and everything that
# touches the filesystem lives here.
#
# Why esbuild
# -----------
# Workspace packages are consumed as TypeScript source (plan/01), so `node`
# cannot import @lj/workflow: it resolves `./x.js` specifiers that only exist as
# `./x.ts`. A bundler is the only way to run the generator, and esbuild is the
# one already pinned in this workspace.
#
# The two design decisions this script implements
# -----------------------------------------------
# 1. Nothing in the rendered file depends on when it was generated, and the
#    filename is a sequence number rather than a timestamp. Identical machine
#    definitions therefore render identical bytes forever, which is what makes
#    `check` a diff rather than a guess.
# 2. Migrations are append-only once merged, so `write` never edits an existing
#    file. It compares against the newest generated migration and, only if the
#    definitions have actually changed, emits the next number. Each generated
#    file replaces the whole table, so applying them in order leaves exactly the
#    current machine's rows, and applying one twice is harmless.

set -eu

mode="${1:-write}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$package_dir/../.." && pwd)
migrations="$repo_root/supabase/migrations"

if ! command -v esbuild >/dev/null 2>&1; then
  echo "generate-transitions: esbuild is not on PATH; run through pnpm" >&2
  exit 1
fi

work=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$work'" EXIT INT TERM

esbuild "$package_dir/src/codegen/main.ts" \
  --bundle --platform=node --format=esm --log-level=warning \
  --outfile="$work/generate.mjs"
node "$work/generate.mjs" >"$work/rendered.sql"

newest=$(ls -1 "$migrations" | grep -E '^[0-9]+_workflow_transitions\.sql$' | sort | tail -n 1 || true)

if [ "$mode" = check ]; then
  if [ -z "$newest" ]; then
    echo "workflow:check: no generated transitions migration is committed." >&2
    echo "  Run 'pnpm workflow:gen'. Until one exists workflow_transition is" >&2
    echo "  empty and the trigger refuses every state change." >&2
    exit 1
  fi
  if diff -u "$migrations/$newest" "$work/rendered.sql" >"$work/diff"; then
    echo "workflow:check: $newest matches the machine definitions"
    exit 0
  fi
  echo "workflow:check: $newest disagrees with the machine definitions." >&2
  echo "  Run 'pnpm workflow:gen' to emit the next migration." >&2
  echo "  (- is the committed file, + is what the definitions render)" >&2
  cat "$work/diff" >&2
  exit 1
fi

if [ "$mode" != write ]; then
  echo "generate-transitions: unknown mode '$mode' (expected write or check)" >&2
  exit 1
fi

if [ -n "$newest" ] && cmp -s "$migrations/$newest" "$work/rendered.sql"; then
  echo "workflow:gen: $newest is already current; nothing to emit"
  exit 0
fi

# The next free sequence number across every migration, not just the generated
# ones: other scopes add migrations too, and a number that collides with one of
# theirs would change the order the schema is built in.
highest=$(ls -1 "$migrations" | sed -n 's/^0*\([0-9][0-9]*\)_.*\.sql$/\1/p' | sort -n | tail -n 1)
next=$((${highest:-0} + 1))
name=$(printf '%04d_workflow_transitions.sql' "$next")

cp "$work/rendered.sql" "$migrations/$name"
echo "workflow:gen: wrote supabase/migrations/$name"
