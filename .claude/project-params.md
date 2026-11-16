<!-- Hand-written in the /setup-project format (that command is Python-only); update it by hand. -->

# Project parameters

Discovery shortcut for /review and /ui-test. Re-verify cheaply instead of searching from
scratch; if the project has drifted, trust what you find over this list.

- Trunk branch: main
- Stack: TypeScript (strict), npm workspaces. React 19 + Vite (`apps/web`), Express 5 (`apps/api`),
  shared TS source (`packages/shared`). MongoDB Atlas (official driver + zod, no Mongoose, ADR-0001).
  Hosting: one Vercel project (ADR-0002).
- Guideline docs: `CLAUDE.md`, `.editorconfig`, `eslint.config.js`, `.prettierrc.json`, `tsconfig.base.json`
- Architecture docs: `ARCHITECTURE.md`, `docs/decisions/` (ADRs 0001-0013), `docs/spec.md`
- Review template: none
- Tests: Vitest, four projects: `api` (node), `web` (jsdom), `shared` and `scripts` (node). Co-located
  next to the source, `*.test.ts` / `*.test.tsx`. Run via `bash .claude/checks.sh test <files>`
  (explicit file paths, never a directory).
- Framework-specific review checks:
  - Boundaries: web never imports api and vice versa; `packages/shared` imports neither app nor
    express/react (ESLint `no-restricted-imports`).
  - Express: every async handler's errors reach the error middleware; validate request bodies with
    the shared zod schema; no request body (phones, addresses) in logs; every state-changing
    request (POST, PATCH, DELETE) passes the `Origin` check (ADR-0004, sameOrigin.ts).
  - External calls (WhatsApp, Mongo, rate-limit store, distances, Web Push) only behind an
    interface with a fake (`MessageSender`, repos, `AttemptStore`, `DistanceMatrix`, `PushSender`).
    Tests never hit the network.
  - Secrets only from env (`apps/api/.env.example` lists them); nothing private in code
    (`ROUTE_START` is Yoel's home).
  - Customer order page: access only by random token, never by id; its actions (decline, cancel,
    change) are POST/PATCH, never GET (a WhatsApp link preview issues GET).
  - React: hook rules, stable keys, no needless re-renders.
  - Serverless: no in-memory state shared across requests (Vercel functions).

## UI layer

- UI framework: React 19 + Vite, Hebrew RTL, mobile first
- UI files: `apps/web/src/`, `apps/web/index.html` (`lang="he" dir="rtl"`, static Open Graph tags)
- Style definitions: `apps/web/src/styles.css` (design system, ADR-0011)
- UI tests: `apps/web/src/**/*.test.tsx` (Testing Library, jsdom), runner `bash .claude/checks.sh test <the test files>`
- Audience notes: most customers are elderly. Font ≥18px, tap targets ≥48px, WCAG AA contrast,
  numeric keyboard for phone and quantity, errors in plain words next to the field.
