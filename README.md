# לתת עוד (BottleRun) — אפליקציית איסוף בקבוקים ותכנון מסלולים

**Zero-cost, mobile-first pickup coordination & route-planning web app** built for the **"Latet Od" ("לתת עוד")** volunteer bottle-collection initiative in Beit Shemesh ("Your bottles, their tefillin!").

Residents book bottle pickups via a bilingual (Hebrew/English) accessible form, confirm pickup time windows via WhatsApp links, and the collector plans half-city collection rounds with an in-process TSP route optimizer.

### Engineering Highlights
- **End-to-End TypeScript Monorepo (`npm workspaces`):** `apps/web` (React 19 + Vite, mobile-first RTL/LTR UI & collector PWA), `apps/api` (Express 5 + official MongoDB driver), and `packages/shared` (Zod schemas, domain logic, bilingual dictionary, and static street dataset). Boundaries enforced via ESLint `no-restricted-imports`.
- **Hexagonal Architecture & Contract Testing:** `createApp(deps)` injects all external boundaries (`OrdersRepo`, `RoundsRepo`, `AttemptStore`, `MessageSender`, `DistanceMatrix`). Reusable `*.contract.ts` test suites verify both in-memory test doubles and MongoDB repositories (including `Promise.all` concurrency races and atomic `ifStatus` / `ifPhase` state transitions).
- **Zero-Runtime-Cost Route Optimization (TSP):** Pre-computed street coordinates from data.gov.il & OpenStreetMap (`packages/shared/data/streets.json`) paired with a pure TSP solver (`planRoute`: branch-and-bound exhaustive up to 8 stops, nearest-neighbor + asymmetric 2-opt above 8 stops).
- **Security & Privacy by Design:** Zero-dependency `node:crypto` `scrypt` password hashing, HMAC-SHA256 stateless renewable cookies, race-condition-proof pre-hash login rate limiting, `Origin` CSRF validation, and PII-redacting structured error logging (`errors.ts`).
- **Architecture Decision Records:** 10 documented ADRs in [`docs/decisions/`](docs/decisions/README.md) covering serverless cold-start mitigation, database trade-offs, WhatsApp integration, and empirical geocoding spikes.

---

## הרצה מקומית (Local Development)

דרוש Node 24.

```bash
npm install
git config core.hooksPath .githooks       # פעם אחת לכל clone: חוסם push ישירות ל-main
cp apps/api/.env.example apps/api/.env

npm run dev:api     # Express על 3000
npm run dev:web     # Vite על 5173, מעביר /api ל-3000

bash .claude/checks.sh all                 # כל הבדיקות: זו ההגדרה של "ירוק"
```

## מסמכים
- [`docs/spec.md`](docs/spec.md): אפיון v2.
- [`docs/decisions/`](docs/decisions/README.md): החלטות ארכיטקטורה (ADRs).
- [`ARCHITECTURE.md`](ARCHITECTURE.md): רכיבים, זרימת הזמנה, גבולות.
- [`docs/deploy.md`](docs/deploy.md): ה-deploy ל-Vercel, משתני סביבה, גיבוי ושחזור, ובדיקות אחרי deploy.
- [`CLAUDE.md`](CLAUDE.md): כללי פיתוח, מונחים, פקודות.
