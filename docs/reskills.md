Set up this TypeScript project for my Claude command system (/dev, /work, /pr,
/review, /ui-test). The commands live globally in ~/.claude/commands/ and are
written against a Python toolchain, so the adapter has to be built here.

## The one thing that matters

The commands never call a test runner or linter directly — they call
`bash .claude/checks.sh <subcommand>`. That file is the only seam. Create it
with EXACTLY this subcommand surface, mapped to this project's real tools:

  test | lint | format | arch | types | sec | build | all      (exit 0 = green)

Map each one to whatever this project actually has — detect it, do not assume:

  lint    -> eslint
  format  -> prettier --check
  types   -> tsc --noEmit
  test    -> the real runner (vitest / jest / node:test)
  sec     -> npm audit --omit=dev
  build   -> the production build, if there is one
  arch    -> likely has no equivalent; see the SKIP rule below

## Four conventions to preserve, copied from ~/.claude/templates/checks.sh

1. A check whose tool is not installed prints `SKIP: <tool> not installed` and
   PASSES. This keeps the script usable before every tool is wired up.
2. `all` runs every check and reports ALL failures — it does not stop at the
   first. /dev and /work rely on this to say which stage broke.
3. `test` forwards extra args, so `checks.sh test path/to/one.test.ts` narrows
   the run. Callers must never have to bypass the wrapper.
4. Export `CI=true` at the top if the runner has a watch mode, or an automated
   caller hangs forever on a keypress prompt.

## Then do these four things

- Add a `build` subcommand if any part of the repo has no tests — compiling is
  that part's only regression signal.
- Write/extend CLAUDE.md with a section stating that `bash .claude/checks.sh`
  is THE definition of green, and naming any generic command that must NOT be
  substituted for it (e.g. a root `npm test` that fans out to a watch-mode
  runner and hangs). Several commands have an "if checks.sh does not exist,
  run `python -m pytest`" fallback branch; this section is what keeps those
  branches dead.
- If anything is generated-not-committed (a Prisma client, a built workspace
  package), add an `ensure_*` helper that regenerates it when missing or stale
  and call it from the checks that need it. A bare `tsc` must not fail with a
  confusing error three layers down.
- Add a `.gitattributes` with `* text=auto eol=lf` if there is none — on
  Windows a committed `.sh` with CRLF kills bash. And in `.gitignore`, ignore
  `.claude/*` but allowlist `!.claude/checks.sh` so the contract is shared
  while per-developer state is not.

## Report

List each subcommand, the command behind it, and which ones SKIP. Then run
`bash .claude/checks.sh all` and show the result.



