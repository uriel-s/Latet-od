#!/usr/bin/env bash
# Toolchain contract for the Claude command system.
# subcommands: test | lint | format | arch | types | sec | security | build | all   (exit 0 = green)
#
# Relationship to CI: there is no CI yet. Vercel runs only `vite build` on deploy
# (ADR-0002), and the GitHub Actions workflow is the DB backup, not a check. So
# this script is the only gate. If a CI job is ever added, it should invoke this
# script rather than restate its commands, so the two cannot drift.
# Checks whose tool isn't installed are SKIPPED with a warning. `all` runs every
# check and reports ALL failures, not just the first.
#
# Hand-ported from ~/.claude/templates/checks.sh (/setup-project is Python-only).
# Deliberate differences from the Python template:
#   - have() looks in node_modules/.bin, not `python -m`: every tool is a
#     devDependency, so "not installed" means `npm install` has not run.
#   - `build` is a new subcommand: web has a single smoke test, so the Vite build
#     (which also compiles packages/shared from source) is its main regression signal.
#   - `arch` always SKIPs: the web/api/shared boundaries are enforced by ESLint
#     (no-restricted-imports in eslint.config.js), so they run under `lint`.
#   - no ensure_* helper: nothing is generated-not-committed. packages/shared is
#     consumed as TS source, so a fresh `npm install` is all any check needs.
set -u

# Runnable from any directory: everything below is relative to the repo root.
cd "$(dirname "$0")/.." || exit 2

# Vitest never watches under CI=true; belt and braces for automated callers.
export CI=true

BIN="node_modules/.bin"
# tsc projects for run_types: the three workspaces plus scripts/ (root-level, its own tsconfig).
WORKSPACES="apps/web apps/api packages/shared scripts"

# True if a devDependency's CLI is installed.
have() { [ -e "$BIN/$1" ]; }

run_lint()   { if have eslint;   then "$BIN/eslint" .;            else echo "SKIP: eslint not installed";   fi; }
run_format() { if have prettier; then "$BIN/prettier" --check .;  else echo "SKIP: prettier not installed"; fi; }
run_arch()   { echo "SKIP: arch — import boundaries are ESLint no-restricted-imports rules; they run under lint"; }

run_types() {
  if ! have tsc; then echo "SKIP: tsc not installed"; return 0; fi
  local rc=0 ws
  for ws in $WORKSPACES; do
    echo "tsc --noEmit -p $ws"
    "$BIN/tsc" --noEmit -p "$ws" || rc=1
  done
  return $rc
}

# Extra args narrow the run (`checks.sh test apps/api/src/app.test.ts`), so callers
# never need to bypass this wrapper. `vitest run` never enters watch mode.
run_test()   { if have vitest; then "$BIN/vitest" run "$@"; else echo "SKIP: vitest not installed"; fi; }

run_build()  { if have vite; then "$BIN/vite" build apps/web; else echo "SKIP: vite not installed"; fi; }

# Production deps only; needs network access to the npm registry.
run_sec()    { npm audit --omit=dev --audit-level=high; }

run_all() {
  local rc=0
  run_lint   || rc=1
  run_format || rc=1
  run_arch   || rc=1
  run_types  || rc=1
  run_sec    || rc=1
  run_test   || rc=1
  run_build  || rc=1
  return $rc
}

case "${1:-all}" in
  test)   shift; run_test "$@" ;;
  lint)   run_lint ;;
  format) run_format ;;
  arch)   run_arch ;;
  types)  run_types ;;
  sec|security) run_sec ;;
  build)  run_build ;;
  all)    run_all ;;
  *) echo "usage: checks.sh {test|lint|format|arch|types|sec|build|all}" >&2; exit 2 ;;
esac
