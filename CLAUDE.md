# BottleRun — "לתת עוד"

## Shell Environment (CRITICAL)

This project runs on **Windows with Git Bash (MINGW64)**. The shell is `/usr/bin/bash`, NOT Windows CMD.

**Rules you MUST follow for every command:**
1. **Always use forward slashes (`/`) in all paths** — never backslashes. Bash treats `\` as an escape character and breaks paths silently.
2. **No virtualenv.** Every tool is an npm devDependency: run it through `npm run …`, `npx …`, or (preferred) `bash .claude/checks.sh …`.
3. **`bash` must be Git Bash, not WSL.** `command -v bash` should print `/usr/bin/bash`. If it resolves to `…/WindowsApps/bash.exe`, use `"C:\Program Files\Git\bin\bash.exe" .claude/checks.sh all`.
4. Git Bash's `$HOME` on this machine is not `C:\Users\<you>`; use full paths for anything under `~/.claude`.

## Project Overview

A bottle-collection booking app for one volunteer collector (Yoel, יואל) in Beit Shemesh. Customers book a pickup through a public Hebrew form; Yoel plans a **round** (date + half of the city), customers confirm via a WhatsApp link, and Yoel drives an ordered list of stops. The money funds tefillin for bar-mitzvah boys and soldiers.

One developer maintains it alone. Priorities, in order: **zero cost, minimum moving parts, easy maintenance.**

Sources of truth — read these before changing behaviour:
- `docs/spec.md` — spec v2 (Hebrew). Supersedes the v1 `.docx` in the root.
- `docs/decisions/` — ADRs 0001-0005. Where an ADR and the spec disagree, the ADR is newer and wins (its README lists what it changes in the spec).
- `ARCHITECTURE.md` — components, order flow, workspace boundaries.

### Glossary (for developers and AI)

UI text is Hebrew; code, identifiers and commit messages are English.

| Hebrew (UI) | Code | Meaning |
|---|---|---|
| הזמנה | `order` | One pickup request. Collection `orders`. |
| לקוח | customer | Whoever books. No account and no `customers` collection: a returning customer is recognized by phone in `orders`. |
| האוסף / יואל | collector | The single logged-in user (ADR-0004). No `users` collection; session `sub: "collector"`. |
| סבב | `round` | A planned collection trip: date + region. Collection `rounds`. Open → closed. |
| אזור / חצי עיר | `region` | `ramat` (רמת בית שמש) or `old` (בית שמש הוותיקה). Derived from the street; empty for a free-text street until Yoel assigns it. |
| עצירה | stop | One order inside a round's route. |
| מסלול | route | Ordered stops: home → stops → drop-off. Computed once by `planRoute` and stored in the round. |
| נקודת פריקה | drop-off | End of every route (נחל נחשון 7), in `apps/api/src/config.ts`. |
| נקודת התחלה | `ROUTE_START` | Yoel's home. Private: env var only, never in code. |
| רחוב / רחוב קרוב | `streetCode` / `nearStreetCode` | Street from the official data.gov.il list; "near street" maps a free-text address onto a known street for region + location (ADR-0005). |
| איפה הבקבוקים | `bottlesSpot` | Private-house entrance / apartment door / building entrance. |
| עמוד ההזמנה | `/o/<token>` | The customer's page. Reached only by a long random `token`, never by id. |
| בקשת אישור | `confirmRequest` | WhatsApp message sent when a round is planned. |
| תודה | `thankYou` | WhatsApp message sent on "אספתי". |
| שולח הודעות | `MessageSender` | Interface for WhatsApp; MVP implementation `WaMeLinkSender` (Yoel taps "send"), fake `FakeSender` (ADR-0003). |

**Order statuses** (`order.status`, spec §4):

| Code | Hebrew | When |
|---|---|---|
| `waiting` | ממתינה לסבב | Created, or back from a round that did not collect it. |
| `pending` | ממתינה לאישור | In a round; confirmation request sent. |
| `confirmed` | אושרה | Customer confirmed, or Yoel marked "אישר בטלפון". |
| `collected` | נאספה | Yoel tapped "אספתי". Final. |
| `cancelled` | בוטלה | Customer or Yoel cancelled. Final. |

Leaving a round is a **reason, not a status**: the order returns to `waiting` and `lastMiss` stores date + reason (לא אישר בזמן, ביקש מועד אחר, לא נמצא במקום, לא הגענו אליו, שינה כתובת). There is no `archived` and no "כתובת לבדיקה" status — an order without a location gets a "בלי מיקום" tag instead.

## Project Structure

```
BottleRun/
├── apps/
│   ├── web/                 # React + Vite SPA: public form, customer page, collector app
│   │   ├── index.html       # lang="he" dir="rtl"; static Open Graph tags go here
│   │   ├── src/             # *.tsx, tests next to the code (*.test.tsx)
│   │   └── vite.config.ts   # also the Vitest "web" project (jsdom); dev proxy /api → :3000
│   └── api/                 # Express
│       ├── src/app.ts       # exports `createApp(deps)`, no listen()
│       ├── src/envDeps.ts   # env → deps, shared by the local and the Vercel entry
│       ├── src/server.ts    # local entry: npm run dev:api
│       ├── .env.example     # every env var the api reads
│       └── vitest.config.ts # Vitest "api" project (node)
├── packages/
│   └── shared/              # TS source consumed directly (no build): types, zod, config, message text
├── api/index.js             # Vercel function (ADR-0002): GENERATED bundle of apps/api/src/vercelEntry.ts, committed; rebuild with `npm run build:api`
├── scripts/                 # one-off Node scripts: geocode-streets, smoke (post-deploy check)
├── vercel.json              # build, rewrites (/api → function, rest → index.html), region iad1, headers
├── .github/workflows/       # backup.yml: weekly mongodump artifact
├── docs/                    # spec.md, decisions/ (ADRs), deploy.md (manual deploy steps), prompts.md, spikes/
├── .claude/checks.sh        # THE definition of green (see below)
├── .githooks/pre-push       # refuses pushes to main
├── eslint.config.js         # lint + workspace boundaries
├── tsconfig.base.json       # strict settings every workspace extends
├── vitest.config.ts         # one `vitest run` over both projects
├── ARCHITECTURE.md
└── CLAUDE.md
```

`packages/shared` has no build step: its `package.json` `exports` points at `src/index.ts`, and Vite, tsx and Vitest compile it in place. Nothing in the repo is generated-but-not-committed.

## Development Commands

```bash
npm install                    # once, and after pulling dependency changes
npm run dev:api                # Express on :3000 (tsx watch, reads apps/api/.env)
npm run dev:web                # Vite on :5173, proxies /api to :3000

bash .claude/checks.sh all     # everything (see "definition of green")
bash .claude/checks.sh test apps/api/src/app.test.ts   # one file
bash .claude/checks.sh lint

npx eslint --fix .             # auto-fix lint
npx prettier --write .         # auto-fix formatting
```

Root `npm test` delegates to `bash .claude/checks.sh test`, so it is the same definition, not a second one.

### `bash .claude/checks.sh` — the definition of "green"

One command answers "is this repository in a good state": **`bash .claude/checks.sh all`.** There is one definition of green, and this is it. Do not substitute a root `npm test`, a bare `vitest` (watch mode — it hangs an automated caller), `tsc` alone, or anything else.

Several global commands (/work, /pr) carry a fallback branch: "if `.claude/checks.sh` does not exist, run `python -m pytest` / `python -m ruff check .`". **That branch is dead here.** The script exists; if it ever appears missing, stop and report — never run pytest or ruff in this repo.

| Subcommand | Runs | Notes |
|---|---|---|
| `lint` | `eslint .` | Includes the workspace import boundaries. |
| `format` | `prettier --check .` | `*.md` and `docs/` are excluded (hand-written Hebrew). |
| `arch` | — | Always `SKIP`: boundaries are ESLint rules and run under `lint`. |
| `types` | `tsc --noEmit -p` for `apps/web`, `apps/api`, `packages/shared`, `scripts` | |
| `sec` | `npm audit --omit=dev --audit-level=high` | Needs network. |
| `test` | `vitest run [files]` | Extra args narrow the run. |
| `build` | `vite build apps/web`, then rebuilds `api/index.js` and fails if it differs from the committed one | web has one smoke test; the build is its main regression signal. After changing anything under `apps/api` or `packages/shared`, run `npm run build:api` and commit `api/index.js`. |
| `all` | all of the above | Runs every check and reports every failure, not just the first. |

A check whose tool is not installed prints `SKIP: <tool> not installed` and passes — on a fresh clone, run `npm install` first or `all` is green for the wrong reason.

**Auto-fixing lint:** `npx eslint --fix .` (and `npx prettier --write .` for `format`). **Never ruff** — `/dev` still contains a hard-coded `python -m ruff check --fix` step; in this repo, substitute the ESLint command.

**What green does NOT cover:**
- Real WhatsApp sending — tests use `FakeSender`.
- The real database on Atlas — tests use in-memory fakes behind the repo interfaces.
- Deploy (Vercel config, env vars, cold start).
- How it looks on a phone and in RTL — use /ui-test or check by hand on a real phone.

## Development Workflow

/work follows this section. Applies to every change, human or AI.

1. **Branch first.** Never commit on `main`. Names: `feature/…`, `fix/…`, `docs/…`, `chore/…`.
2. **Read before writing.** Find the spec section and ADR the change touches; follow them, or say explicitly where you deviate and why.
3. **Interfaces first.** Shared types / zod schemas in `packages/shared`, then the api, then the web UI.
4. **Tests with every change.** Write or update the test next to the code (`foo.ts` → `foo.test.ts`).
5. **Narrow check while working:** `bash .claude/checks.sh test <the test files you touched>` — explicit file paths only, never a bare `test` or a directory. Then `bash .claude/checks.sh lint`.
6. **Full check before every commit you hand over:** `bash .claude/checks.sh all` must be green.
7. **Commit** with explicit paths (`git add <files>`, never `git add -A` / `git add .`) and an English message in the imperative. Never commit `.env`, `.work-context.md`, or `.dev-*` files.
8. **Never push or merge without the user's explicit approval.** Pushing `main` is blocked by the pre-push hook; open a PR (/pr).

## Rules

- **Hebrew and RTL.** All UI text is Hebrew; `dir="rtl"` on the document. Phone numbers and digits render LTR inside the text (`<bdi>` / `dir="ltr"`). Dates `DD/MM`. Time zone `Asia/Jerusalem`, also for monthly statistics.
- **Mobile first, built for elderly customers.** Single column, font ≥18px, tap targets ≥48px, WCAG AA contrast, numeric keyboard for phone and quantity, errors in plain words next to the field.
- **No secrets in code.** Everything secret or private comes from env; `apps/api/.env.example` lists every variable with no real values; `.env` is git-ignored. Yoel's home address (`ROUTE_START`) counts as private.
- **Every external call sits behind an interface with a fake for tests.** Today: WhatsApp → `MessageSender` (ADR-0003). Also MongoDB → repositories (`OrdersRepo`, `RoundsRepo`), rate-limit store → `AttemptStore` (ADR-0004), distances → `DistanceMatrix` (ADR-0005). Tests never touch the network or Atlas.
- **Privacy.** No public page shows another customer's data; the customer page is reached by random token only; never log request bodies (phones, addresses).
- **Serverless.** The api runs as a Vercel function: no in-memory state shared between requests, no background jobs, no cron.
- **Boundaries.** `apps/web` and `apps/api` never import each other; `packages/shared` imports neither app nor express/react. ESLint enforces this.
- **zod in `packages/shared` is the single source of data shape** — for the form, the request, and what is read from Mongo. No Mongoose (ADR-0001).
- **Footer credit** "© OpenStreetMap contributors" stays on every page once street points are in use (ADR-0005).

## Code Readability & Comments

- When adding or changing code, add or update comments so intent and non-obvious behaviour are clear. Comment the *why* — business rules (minimum 30 bottles, one open order per phone), workarounds, assumptions — not the obvious *what*.
- A one- or two-line comment at the top of each module that is not self-explanatory: what it does and how it fits in.
- JSDoc (`/** … */`) on exported functions, types and components whose name does not already say everything.
- Descriptive names (`bottlesEstimated`, not `count`); small single-purpose functions; explicit types on exported signatures.
- When you touch a file, leave its comments a little better than you found them.

## Testing Conventions

- **Vitest**, four projects: `api` (node), `web` (jsdom), `shared` and `scripts` (node). Tests live next to the code: `src/foo.ts` → `src/foo.test.ts`, components `*.test.tsx`.
- `describe` per unit, `it('…')` names that state the expected behaviour (`it('rejects fewer than 30 bottles')`).
- api routes: `supertest` against the exported `app` — no `listen()`, no port.
- React: Testing Library, query by role / visible text (Hebrew), not by class or test id.
- Fakes, not mocks, for the external interfaces above; `makeOrder(overrides)`-style helpers for test data.
- Happy path first, then edges: minimum 30 bottles, Israeli mobile format, duplicate open order, expired/forged token, status transitions that must be refused.

## Adding Dependencies

1. `npm install <pkg> --workspace apps/api` (or `apps/web`); dev tools used repo-wide go in the root with `-D`.
2. Prefer no dependency: Node 24 and the existing stack cover a lot (`node:crypto` scrypt instead of bcrypt, ADR-0004).
3. `bash .claude/checks.sh sec` — no high/critical advisories in production deps.
4. Commit `package.json` and `package-lock.json` together.
5. **TypeScript stays on 6.0.x** until typescript-eslint supports 7 (its peer range is `<6.1.0`).

## Git Hooks

`.githooks/pre-push` refuses pushes to `main` / `master` / `trunk`. Git does not pick up a versioned hooks directory on its own — **run once per clone:**

```bash
git config core.hooksPath .githooks
```

Maintainer who merges locally and pushes `main`: `git config claude.allowTrunkPush true` in that clone. `git push --no-verify` bypasses the hook; it stops accidents, not determined pushes.

## Configuration

- **Env vars** (`apps/api/.env`, template in `.env.example`): `PORT`, `MONGODB_URI`, `NODE_ENV`, `COLLECTOR_PASSWORD_HASH`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `MESSAGE_SENDER` (default `wame`) are in use; the api refuses to start (locally) or answers 500 (Vercel) if one is missing or malformed. `ROUTE_START` arrives with route planning. `MONGODB_BACKUP_URI` is a GitHub secret for the backup workflow only. Deploy steps: `docs/deploy.md`.
- **Settings in code, no settings screen** (ADR-0005): bottle value (20 agorot) in `packages/shared`, drop-off point in `apps/api/src/config.ts`, start point from `ROUTE_START`.
