# BottleRun ("לתת עוד") — Code Quality Review

**Date:** 2026-11-11

## Context

A bottle-collection booking app for one volunteer collector in Beit Shemesh. It has three parts: a
public booking form in Hebrew and English, a customer page reached by a random token, and a Hebrew
collector PWA for planning rounds and driving them. One developer maintains it. The stated
priorities are zero cost, few moving parts and easy maintenance.

| | Discovery |
|---|---|
| **Tech stack** | TypeScript 6.0 end to end, Node 24. React 19 + Vite 8 SPA. Express 5 running as a Vercel function: an esbuild bundle committed as `api/index.js`. Official MongoDB driver 7, no Mongoose. zod 4. npm workspaces. |
| **Architecture** | Monorepo with three workspaces (`apps/web`, `apps/api`, `packages/shared`) plus `scripts/`. **api:** a composition root (`createApp(deps)`) with feature folders (`orders`, `rounds`, `auth`, `push`, `history`). Each external system sits behind an interface, with an in-memory fake and a Mongo/HTTP implementation. **web:** route-level screens (`collector/`, `pages/`, `orderForm/`), one network module (`api.ts`) and a hand-written router. **shared:** zod schemas, one contract file per endpoint group (`*Api.ts`), the `t()` dictionary, and pure domain functions (`planRoute`, `canTransition`). |
| **Guidelines** | `CLAUDE.md` (workflow, rules, comments, testing), `ARCHITECTURE.md`, `docs/spec.md`, 13 ADRs, `eslint.config.js` (`recommendedTypeChecked` plus workspace import boundaries), `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`), Prettier. `.claude/checks.sh` is the single definition of green. |
| **Tests** | Vitest in four projects (api/node, web/jsdom, shared, scripts). 121 test files with ~2,270 `it`/`test` calls; 179 `.each` tables expand that to 3,290 executed tests. No `.skip` or `.only`. supertest without `listen()`. Testing Library queries by role and Hebrew text. Four repository contract suites. |
| **Size** | 159 non-test source files, ~25.5k LOC (15.4k code lines, 7.8k comment lines). ~38.7k test LOC, about 1.5× the source. Largest files: `apps/web/src/api.ts` 1,252 lines, `scripts/transliterateStreetName.ts` 820, `scripts/geocode-streets.ts` 819, `pages/OrderPage.tsx` 811, `collector/RoundsScreen.tsx` 756, `collector/PlanRoundScreen.tsx` 710. |
| **Green** | `bash .claude/checks.sh all` on the reviewed tree: see the last line of this section. |

Scope: started on branch `feature/whatsapp-message-wording`, which was merged into `main` while
the review ran (`a1548fc`, wording changes only). The project has fewer than 200 source files, so
the review ran as one pass with no fan-out to subagents.

**`checks.sh all`:** green. lint, format, types (all four projects), sec (0 vulnerabilities) and
build (`api/index.js` up to date) passed. One test failed in the first run because the run
caught the branch mid-commit. On the merged tree, `checks.sh test` passes 121/121 files and
3,290/3,290 tests (~100 s; 62% of that time goes to creating jsdom 49 times).

---

## 1. Modularity & SOLID — Score: 7.4/10

| Principle | Score | Evidence |
|---|---|---|
| **S** Single Responsibility | 6 | **The api side is clean.** `errors.ts` only logs and answers errors. Repos are "dumb storage". Domain steps are extracted and reused: `leaveRoundPatch` serves `closeRound.ts`, `customerOrderRoutes.ts`, `customerOrderPatch.ts` and `collectorStopActionsRoutes.ts`, and both round routers share `sendAndLog`. One exception: two orchestrations still sit inside route handlers in `rounds/collectorRoundsRoutes.ts`. Planning runs ~75 lines (validate → create round → move N orders conditionally → close an empty round → send N messages), and "התחל מסלול" picks the stops inline. **The web side is where SRP breaks.** `apps/web/src/api.ts` is one 1,252-line module for every resource: booking, auth, collector orders, rounds, stop actions, history, the customer page and push. `OrderPage` is a 360-line component function (`OrderPage.tsx:204-566`) and `PlanRoundForm` is 390 lines (`PlanRoundScreen.tsx:281-673`). `RoundsScreen` holds 8 `useState` and 6 `useRef`. `bottlesText`, a text helper, lives in `OrdersScreen.tsx`, and four other screens import it from there. |
| **O** Open/Closed | 8 | `MessageSender` is picked by an env factory (`createMessageSender`), so adding the `CloudApiSender` from ADR-0003 takes one class and one branch. `DistanceMatrix` leaves room for OSRM. Status moves are table-driven (`ORDER_TRANSITIONS` + `canTransition`). The region set is defined once (`regionSchema`); outside the demo seed and test factories nothing hard-codes `'ramat'`/`'old'`. Texts go through `t()`. Minor: `ORDER_GROUP_KEYS` re-lists the regions instead of deriving from `regionSchema`. |
| **L** Liskov Substitution | 7 | Contract suites prove that the in-memory `OrdersRepo`, `RoundsRepo`, `AttemptStore` and both `PushSubscriptionsRepo`s honour one contract. Senders resolve `{ mode: 'failed' }` / `{ status: 'failed' }` instead of rejecting, as their interfaces promise. The gap: the three implementations that run in production, `MongoOrdersRepo`, `MongoRoundsRepo` and `MongoAttemptStore`, never run their contract (Key Risk 1). Every route test uses the fakes, so it is asserted, not proven, that the fakes stand in for them. |
| **I** Interface Segregation | 8 | Each router names only what it uses: `createCollectorRoundsRouter(deps: Pick<AppDeps, 'orders' \| 'rounds' \| 'messaging' \| 'route'>)`, `notifyNewOrder(deps: Pick<AppDeps, 'pushSubscriptions' \| 'push'>)`. The repo interfaces are cohesive (`OrdersRepo` has 7 methods, all used). Gap on the web: screen props carry API functions that the intermediate components only forward. `RoundsScreenProps` holds `moveStop`, `collectStop`, `markStopNotFound` and `markOpened`, which serve `RouteScreen`, `StopCard` and `SendList` and are never called in `RoundsScreen` itself. |
| **D** Dependency Inversion | 8 | `createApp(deps)` is a real composition root, and both entry points (`server.ts`, `vercelEntry.ts`) build deps with `depsFromEnv`. Every external system sits behind an interface with a fake: repos, `AttemptStore`, `MessageSender`, `PushSender`, `DistanceMatrix`. In the web, `api.ts` takes a `FetchFn`. Screens bind the concrete api functions as default arguments (`loadRounds = fetchRounds`). That is acceptable as inversion; the cost shows up under Testability. |

Mean: (6 + 8 + 7 + 8 + 8) / 5 = **7.4**

### Architecture Highlights
- **Composition root + `Pick<AppDeps, …>`.** Each router declares the dependencies it needs, and its tests build only those.
- **Repository contract suites** (`ordersRepo.contract.ts`, 584 lines). A fake proven against one specification is worth more than a mock.
- **`packages/shared` as the single source of data shape.** The same zod schemas parse Mongo documents, API requests and form input, and every endpoint has its `*Api.ts` contract. The import graph inside `shared` is acyclic, and ESLint enforces the workspace boundaries.
- **Concurrency built into the repo API.** `ifStatus`/`ifPhase` make check-and-write one atomic step. Every status change pairs `canTransition` with a conditional update, so a race becomes a clean 409.
- **A privacy-first error path.** `errors.ts` logs from an allow-list of fields, and the 404 never echoes a path that holds a token.

### Improvement Opportunities
1. **Split `apps/web/src/api.ts` by resource**, mirroring `shared` (`authApi`, `collectorOrdersApi`, `roundsApi`, …), around one `request()` helper. The helper owns the common cases: network error → `failed`, 401 → `loggedOut`, unreadable body → `failed`, schema parse. Today that handling is written out in 19 `switch (response.status)` blocks with 16 `case 401` arms.
2. **Extract `planRound()` and `startRoute()`** from `collectorRoundsRoutes.ts` into `rounds/planRound.ts` and `rounds/startRoute.ts`, as `closeRound.ts` already is. The handlers then only parse the request, call the function and map its result to a status.
3. **Split `OrderPage` and `PlanRoundForm`** into a state hook plus presentational parts; `orderForm/useOrderForm.ts` already shows the pattern.
4. **Move `bottlesText`/`ordersText` to `collector/texts.ts`**, so that no screen imports another screen.

---

## 2. Guidelines & Policy Adherence — Score: 8.2/10

| Category | Rating | Evidence |
|---|---|---|
| Documentation | **Minor gap** | **Quality is high.** Comments explain *why* (privacy, races, ADR references), as `CLAUDE.md` asks. **Volume is past the band.** Source has 7.8k comment lines for 15.4k code lines (0.51). The shared contract files run 1.1–2.4× comment to code: `customerOrderApi.ts` 134/56, `authApi.ts` 64/42, `roundsApi.ts` 291/250. The JSDoc on `createCollectorRoundsRouter` is ~75 lines that repeat the contract already in `roundsApi.ts` and in the mount comments of `app.ts`. **Every endpoint is described in 3–4 places, and the copies have drifted.** `ARCHITECTURE.md` ("מה שייך ל-shared") gives the minimum as 30 bottles, while the code says `MIN_BOTTLES = 20` (`order.ts:18`). `ordersRepo.ts:4` and `roundsRepo.ts:5` say the contract suite "runs against every implementation, so the fake and the Mongo repo cannot drift apart", which no test does. |
| Naming | **Excellent** | Names carry units and intent: `JSON_BODY_LIMIT`, `SESSION_RENEW_AFTER_MS`, `MAX_START_DISTANCE_METERS`, `bottlesEstimated` vs `bottlesCollected`. The glossary in `CLAUDE.md` maps the Hebrew UI to the code. Historic names stay for data compatibility, and each one says so (`confirmRequest`, phase `confirming`, error `confirmations_closed`, ADR-0012). |
| Type safety | **Perfect** | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `noUnused*`, linted with `recommendedTypeChecked`. Source has no `any`, no `as unknown as` and no `@ts-ignore`/`@ts-expect-error`. The one `eslint-disable` carries its reason (`errors.ts:65`: Express needs four parameters). The client returns typed outcome unions (`CreateOrderOutcome` and others, discriminated on `kind`). |
| Security | **Excellent** | scrypt + `timingSafeEqual` (`passwordHash.ts`), and an HMAC session cookie compared in constant time (`session.ts`). An Origin check runs on every route, before the body is parsed (`sameOrigin.ts`). `trust proxy 1`, so a client cannot spoof `X-Forwarded-For`. A 10kb body limit. Per-IP and global rate limits persisted in Mongo, which is serverless-safe. The 404 never echoes the path. Logs use an allow-list. `Referrer-Policy` is set, and `/o/*` gets `noindex`. No `eval`, `innerHTML` or `dangerouslySetInnerHTML`. Gap: `vercel.json` sets no `Content-Security-Policy`. |
| Test conventions | **Minor gap** | **Strong:** `it` names state behaviour; contract suites; supertest without `listen()`; queries by role and Hebrew text; bug fixes ship with regression tests (every one of the last 7 fix commits that touched source also touched tests). **Copy-paste:** `makeOrder` is defined separately in 18 test files (only the api has a shared `makeOrder.ts`), `deferred` in 12, `firstRealStreet` in 8. `api.test.ts` (2,357 lines) repeats the same three tests for each endpoint: "loggedOut on 401", "failed on any other status", "failed after a network error". Parametrization itself is well used: 179 `.each` tables produce about 1,000 of the 3,290 executed tests. The copy-paste is concentrated in the helpers and in `api.test.ts`. **White-box:** `mongoOrdersRepo.test.ts` imports 9 internals (`toOrder`, `buildUpdate`, `buildListFilter`, …) that are exported only for it, and no test ever creates the class. A few colour assertions query CSS classes (`RoundsScreen.test.tsx:536-560`), which is acceptable for decoration. |
| Code organization | **Minor gap** | Tests sit next to the code, the api uses feature folders, ESLint enforces the boundaries, and `shared` has no import cycles. Against that: the 1,252-line `api.ts`, five web files over 500 lines, screens importing helpers from other screens (`bottlesText`), and `collector/` as 29 flat files that mix screens, sheets, hooks and pure helpers. |

Rating to score: Perfect 10, Excellent 9, Minor gap 7, Major gap 4 → (7 + 9 + 10 + 9 + 7 + 7) / 6 = **8.2**

**Bottom line:** the code really follows the project's own rules. Workspace boundaries, privacy in
logs, zod as the single shape, fakes behind every external call and tests with every change are all
enforced, not aspirational. Both gaps are about volume: prose has grown faster than anyone can keep
it true, and test helpers are copied instead of shared.

---

## 3. Changeability & Debuggability — Score: 7.6/10

| Sub-dimension | Score | Evidence |
|---|---|---|
| **Changeability** | 7 | Swapping a component is local: sender, distance, repo, push. Changing *behaviour* costs more than it should. An endpoint's contract lives in shared `*Api.ts`, in the router's JSDoc, in the mount comment in `app.ts` and in `ARCHITECTURE.md`. Hebrew texts exist as a constant and again as a copy in `i18n.ts` (17 "change both" notes; equality tests in `i18n.test.ts` catch a mismatch). One change to how the client handles 401 or 5xx means 16–19 edits in `api.ts`. |
| **Reachability** | 8 | Composition, routers, repos and senders all have live callers (`server.ts` / `vercelEntry.ts` → `depsFromEnv` → `createApp`). **Dead or test-only:** `waMeUrl` (`waMeLinkSender.ts:50`). `roundPickerLabel` (`roundPicker.ts:85`). `generateVapidKeys` (`webPushSender.ts:90`), while `.env.example:51` has the user run a separate `node -e` one-liner instead. The Hebrew aliases in `OrderPage.tsx`: nothing references `ORDER_PAGE_HEADING`, and only tests reference `WAITING_TEXT`, `COLLECTED_TEXT`, `CANCELLED_TEXT`, `LEFT_ROUND_MESSAGE` and `PHONE_NOT_CHANGED_TEXT`. The `NOT_FOUND_QUESTION` re-export in `StopCard.tsx:34`, used only by `StopCard.test.tsx`. `DisabledPushSender.send` is built (`pushConfig.ts:76`) but never called, because `notifyNewOrder` returns on `publicKey === null` first. The Mongo contract runs exist only as code inside JSDoc (`mongoOrdersRepo.ts:75`, `mongoRoundsRepo.ts:30`, `mongoAttemptStore.ts:43`), which nothing executes. |
| **Debuggability** | 7 | **Server:** one-line JSON logs with level, event and route pattern; a `push_summary` line per new order; env errors that name the variable. A deliberate privacy trade-off: an error that is not a TypeError, ReferenceError or RangeError is logged without its message, so a Mongo error shows only its name, code and stack frames. **Client:** about 15 `catch { outcome = { kind: 'failed' } }` guards (`RoundsScreen.tsx:340`, `OrderFormPage.tsx:150`, …) cover rejections that "cannot happen". If one does happen, the user sees a generic network-error message and the console shows nothing, so a bug in `api.ts` would be invisible. There is no request or correlation id linking a client failure to a server log line. |
| **Testability** | 7 | The server is exemplary: `createApp(deps)`, `Pick<>`, fakes, supertest, injectable clocks. **The reverse check lowers the score.** (a) Every collector screen takes its API functions as optional props that production never passes: `CollectorShell.tsx` renders `<RoundsScreen />`, `<OrdersScreen />`, … with no props. `RoundsScreen` forwards `moveStop`/`collectStop`/`markStopNotFound`/`markOpened` through `RoundSection → RouteScreen → StopCard → SendList` purely for tests, a second injection layer on top of the `FetchFn` that `api.ts` already takes. (b) The Mongo repos export ~10 internals each so tests can call them, and the class itself goes untested. (c) The `StopCard` re-export shim. A smaller cost: the full run takes ~100 s, and 62% of that is creating jsdom 49 times; Vitest's `pool: 'vmThreads'` would shorten the feedback loop. |
| **Error Handling** | 9 | One error middleware with status mapping (`errors.ts`). Expected failures are values, not exceptions: `SendResult`, `PushSendResult`, the client's `*Outcome` unions. Conditional writes turn races into 409s with plain-Hebrew messages. Push is best-effort and cannot fail a booking. `/api/health` answers 503 when the database is down. A bad env stops the local server, and on Vercel every request gets a 500. Nit: some guards are doubled; `createOrderRoute.ts:113-117` wraps `notifyNewOrder`, which already catches everything. |
| **State Management** | 7 | **Server:** stateless per request (serverless), with atomic `ifStatus`/`ifPhase` writes; closing a round is idempotent and re-sweeps its orders. Planning writes several documents without a transaction. The partial cases are handled (an empty round is closed, `orderIds` is trimmed), but a crash between `rounds.create` and the order updates leaves an open round listing `waiting` orders until Yoel closes it. **Client:** state and mirror-ref pairs (`buildingIds`/`buildingIdsRef` and `closingIds`/`closingIdsRef` at `RoundsScreen.tsx:210-216`; `busyIdsRef` at `RouteScreen.tsx:200`) are two update paths that must be kept in step by hand for the double-tap guard. `PlanRoundScreen` has 12 `useState`. A reducer per screen would keep the guard and the rendered state in one place. |
| **Configuration** | 9 | One env→deps function (`envDeps.ts`) whose errors say what to fix and never echo a value. `.env.example` lists every variable. VAPID is all-or-none. `ROUTE_START` must be within 30 km of the drop-off. Fixed settings live in code, per ADR-0005. Nit: "push disabled" is represented twice (`publicKey: null` *and* `DisabledPushSender`); `push: PushDeps \| null` would make it one. |
| **Code Organization** | 7 | Feature folders, colocated tests, ESLint-enforced boundaries, no cycles in `shared`. The largest file is `api.ts` at 1,252 lines, followed by `OrderPage` 811, `RoundsScreen` 756, `PlanRoundScreen` 710, `StopCard` 541 and `RouteScreen` 509. `collector/` is flat. |

Mean: (7 + 8 + 7 + 7 + 9 + 7 + 9 + 7) / 8 = **7.6**

### Key Risks
1. **The Mongo repos are never checked against their contract.** Every route test runs on
   `InMemoryOrdersRepo` / `InMemoryRoundsRepo`. The Mongo classes are covered only through their
   pure helpers. All of the following could behave differently on Atlas while `checks.sh all`
   stays green: the partial unique index (one open order per phone), `$unset` for `undefined`
   keys, `ifStatus` atomicity, sort tie-breaks and the `closedBetween` filter. The comments claim
   the opposite, so nobody is looking.
2. **The prose drifts.** There are ~7.8k comment lines, and each behaviour is described in 3–4
   places. Two statements are already wrong in places a maintainer (or an AI following
   `CLAUDE.md`'s "read before writing") would trust: the 30-bottle minimum and the claim about the
   contract suites. The more trustworthy the docs look, the more a wrong one costs.
3. **Client failures are silent, and the status handling is duplicated.** If an `api.ts` function
   throws (after a schema change, or a parse bug), the screen says "check your connection" and logs
   nothing. The 401/`failed` handling that would need the fix is copied 16–19 times.

---

## Overall Summary

| Dimension | Score |
|-----------|-------|
| Modularity & SOLID | **7.4/10** |
| Guidelines & Policy | **8.2/10** |
| Changeability & Debuggability | **7.6/10** |
| **Overall** | **7.7/10** |

### Top 5 Actionable Improvements (Priority Order)
1. **Run the repo contract suites against MongoDB.** Add `mongoOrdersRepo.integration.test.ts`
   (and the same for rounds and attempts), calling `describeOrdersRepoContract` inside
   `describe.runIf(process.env.MONGODB_TEST_URI)` with a throwaway database per run. Write the one
   command in `docs/deploy.md`. It needs no new dependency and costs nothing (a local `mongod` or a
   free Atlas test database). Until it exists, correct the "runs against every implementation"
   comments in `ordersRepo.ts` and `roundsRepo.ts`.
2. **Split `apps/web/src/api.ts` by resource around one `request()` helper.** The helper handles
   network errors, 401, unreadable bodies and schema parsing once, and calls `console.error` on
   unexpected exceptions so the screen-level `catch` blocks stop being silent. Replace the
   per-endpoint trio of tests in `api.test.ts` with one `it.each` table over the endpoints.
3. **Give the web one API injection point.** Add a small `ApiContext` whose default value is the
   real api; screens call `useApi()`, and tests wrap the screen in a provider with fakes. Then
   remove the API-function props from the screens, along with their forwarding through
   `RoundSection → RouteScreen → StopCard → SendList`.
4. **Shrink the prose and keep each fact in one place.** Make the shared `*Api.ts` file the only
   description of an endpoint's contract, and cut each router's JSDoc down to a pointer to it. Fix
   `ARCHITECTURE.md` (30 → 20 bottles). Derive the Hebrew constants from `t('he', …)`, as
   `OrderPage.tsx` already does, and retire the "change both" pairs.
5. **Delete dead code and share test fixtures.** Remove `waMeUrl`, `roundPickerLabel`,
   `ORDER_PAGE_HEADING` and the test-only `OrderPage` aliases, and the `StopCard` re-export. Either
   give `generateVapidKeys` a live caller (an `npm run vapid-keys` CLI, like `hash-password`) or
   delete it. Replace `DisabledPushSender` with `push: PushDeps | null`. Move `makeOrder`,
   `deferred` and `firstRealStreet` into one test-fixtures module (for example
   `packages/shared/src/testing/`, under its own `exports` entry, which no app code imports).

### What NOT to Change
Each item below was checked for a live runtime caller.
- **`createApp(deps)` + `depsFromEnv`**: both entry points build their deps through it (`server.ts:14`, `vercelEntry.ts:14`).
- **Per-router `Pick<AppDeps, …>`**: dependency surfaces that are small, explicit and easy to fake.
- **Conditional writes (`ifStatus`/`ifPhase`) + `ORDER_TRANSITIONS`**: used across the order and round routes, `closeRound.ts` and `leaveRound.ts`. This is what makes double taps and racing screens safe.
- **`errors.ts`**: allow-list logging and the single error middleware (registered last, `app.ts:117`).
- **zod in `packages/shared` as the only data shape, and the ESLint workspace boundaries.**
- **The in-memory fakes and their contract suites**: extend them to Mongo; don't replace them with mocks.
- **The client's typed `*Outcome` unions**: keep the shape, and only deduplicate the plumbing behind it.
- **`checks.sh` as the one definition of green**, including the stale-bundle check on `api/index.js`.
- **The zero-dependency choices that are live**: the hand-written router (22 importers) and `node:crypto` scrypt for the password.
