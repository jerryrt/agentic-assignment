#!/bin/sh
#
# Emit (or verify) the stylesheets generated from design/tokens.json.
#
#   sh tools/generate-tokens.sh write   # pnpm tokens:gen
#   sh tools/generate-tokens.sh check   # pnpm tokens:check
#
# Why this is a shell script and not TypeScript
# --------------------------------------------
# The same split as packages/workflow/tools/generate-transitions.sh, for the
# same reason: rendering is a pure function from the token JSON to a string and
# prints to standard output, and everything that decides where files live, what
# they are compared against and what the failure message says lives here. That
# is what makes `check` a `diff -u` against the committed bytes rather than a
# second comparison implemented in a second language.
#
# Where it deliberately differs from that generator
# -------------------------------------------------
# 1. No bundler. generate-transitions.sh runs esbuild because it has to import
#    @lj/workflow, and `node` cannot: workspace packages are consumed as
#    TypeScript source through "./x.js" specifiers that only exist as "./x.ts".
#    This renderer imports nothing from the workspace -- its whole input is a
#    JSON file -- so Node's own type stripping runs it directly. A build step
#    that is not needed is a build step that can break.
# 2. `write` overwrites in place. Migrations are append-only once merged, so the
#    transitions generator emits the next numbered file and never edits one.
#    These two artefacts are not history; they are the current palette, and one
#    stale copy of them is exactly the drift the check exists to catch.
#
# What is the same, on purpose: the two modes and their names, the exit codes,
# the temp-directory-then-diff shape, and a failure message that names the
# command to run. Two generated-artefact checks that work differently is a
# smell; two that work the same way is a convention.

set -eu

mode="${1:-write}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$package_dir/../.." && pwd)

tokens_json="$repo_root/design/tokens.json"
out_dir="$package_dir/tokens"

if [ ! -f "$tokens_json" ]; then
  echo "generate-tokens: $tokens_json does not exist" >&2
  exit 1
fi

work=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$work'" EXIT INT TERM

node "$script_dir/render-tokens.ts" css "$tokens_json" >"$work/_tokens.css"
node "$script_dir/render-tokens.ts" scss "$tokens_json" >"$work/_palette.scss"

if [ "$mode" = check ]; then
  status=0
  for artefact in _tokens.css _palette.scss; do
    if [ ! -f "$out_dir/$artefact" ]; then
      echo "tokens:check: packages/ui/tokens/$artefact is not committed." >&2
      status=1
      continue
    fi
    if diff -u "$out_dir/$artefact" "$work/$artefact" >"$work/$artefact.diff"; then
      continue
    fi
    echo "tokens:check: packages/ui/tokens/$artefact disagrees with design/tokens.json." >&2
    echo "  (- is the committed file, + is what the tokens render)" >&2
    cat "$work/$artefact.diff" >&2
    status=1
  done
  if [ "$status" -ne 0 ]; then
    echo "tokens:check: run 'pnpm tokens:gen' and commit the result." >&2
    echo "  A colour belongs in design/tokens.json and nowhere else; a stale" >&2
    echo "  stylesheet is a second, undocumented theme." >&2
    exit 1
  fi
  echo "tokens:check: _tokens.css and _palette.scss match design/tokens.json"
  exit 0
fi

if [ "$mode" != write ]; then
  echo "generate-tokens: unknown mode '$mode' (expected write or check)" >&2
  exit 1
fi

mkdir -p "$out_dir"
changed=0
for artefact in _tokens.css _palette.scss; do
  if [ -f "$out_dir/$artefact" ] && cmp -s "$out_dir/$artefact" "$work/$artefact"; then
    continue
  fi
  cp "$work/$artefact" "$out_dir/$artefact"
  echo "tokens:gen: wrote packages/ui/tokens/$artefact"
  changed=1
done

if [ "$changed" -eq 0 ]; then
  echo "tokens:gen: _tokens.css and _palette.scss are already current"
fi
