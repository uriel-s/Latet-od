# ארכיטקטורה: BottleRun ("לתת עוד")

> מסכם את `docs/spec.md` ואת `docs/decisions/` (ADRs 0001-0006). איפה שיש סתירה, ה-ADR קובע.
> מצב נוכחי (2026-10-21): P4 בעבודה. קיימים: רשימת הרחובות, הטופס הציבורי, ההתחברות, מסך ההזמנות, הודעות wa.me,
> תכנון סבב ואישורים, עמוד ההזמנה של הלקוח, המסלול, "אספתי" ו"לא נמצא", "סגור סבב", ההיסטוריה והסטטיסטיקה החודשית,
> ה-function ב-Vercel והגיבוי. כל מסכי ה-MVP של spec §3 בקוד. ריצה 2 (מהאפליקציה המותקנת ועד ההיסטוריה)
> עוד לא מוזגה ל-`main`, ולכן עוד לא באתר.

## רכיבים

| רכיב | מה | איפה | החלטה |
|---|---|---|---|
| **web** | SPA ב-React + Vite. שלושה חלקים: טופס ציבורי (`/`), עמוד הזמנה של הלקוח (`/o/<token>`), אפליקציית האוסף (אחרי התחברות). רק את אפליקציית האוסף אפשר להוסיף למסך הבית (PWA): `manifest.webmanifest`, `icon.svg` (המקור) והאייקונים ב-PNG נמצאים ב-`apps/web/public`, ו-`pwaHead.tsx` מוסיף את התגיות ל-head רק ב-`/login` וב-`/app/*`. בלי service worker. `viewport-fit=cover` ב-`index.html`, וריווח `safe-area` ב-`styles.css`. באפליקציה המותקנת אין רענון בגרירה, ולכן מסכי הרשימה (`OrdersScreen`, `RoundsScreen`, `HistoryScreen`, ורק הם) נטענים מחדש כשיואל חוזר לאפליקציה (`collector/useReloadOnReturn.ts`). מסכי ההוספה, העריכה והתכנון לא, כדי לא למחוק מה שהוקלד. מאותה סיבה `RoundsScreen` מדלג על הטעינה כל עוד שדה הכמות של "אספתי" פתוח במסלול. שתי השאלות של סוף סבב יושבות בקבצים משלהן: `collector/BuildRouteConfirm.tsx` ("סגור אישורים ובנה מסלול") ו-`collector/CloseRoundConfirm.tsx` ("סגור סבב"). ב-`/login` באייפון, מחוץ לאפליקציה המותקנת, מופיעה שורת התקנה (`pages/installHint.ts`). הבדיקה באייפון: `docs/deploy.md` סעיף 11. | `apps/web` | ADR-0001, 0006 |
| **api** | Express. `app.ts` מייצא את `createApp(deps)`, שמקבל את התלויות החיצוניות (repos, בדיקת DB, הגדרות ההתחברות וה-WhatsApp). יש שתי נקודות כניסה דקות, ושתיהן בונות את התלויות האמיתיות עם `depsFromEnv` (`envDeps.ts`: `createMongoDeps` + `authDepsFromEnv` + `messagingDepsFromEnv` + `routeDepsFromEnv`, נקודת ההתחלה מ-`ROUTE_START`): `server.ts` (מקומי / hosting רגיל), ו-`apps/api/src/vercelEntry.ts`, ה-function של Vercel (דרך `createVercelHandler`, שבונה את האפליקציה בבקשה הראשונה). Vercel לא אורז קבצי TS של הריפו, ולכן `npm run build:api` (esbuild) אורז אותו, יחד עם קוד ה-api ו-`packages/shared`, ל-`api/index.js` שנשמר ב-git. רק `express` ו-`mongodb` נשארים חיצוניים. `checks.sh build` נכשל אם החבילה לא מעודכנת. בבדיקות: `createFakeDeps()`. | `apps/api`, `api/index.js` (נוצר) | ADR-0001, 0002 |
| **shared** | קוד TS שנצרך ישירות, בלי build: טיפוסים, סכמות zod, `renderMessage`, קבועים (שווי בקבוק, `BOTTLE_VALUE_AGOROT` ב-`config.ts`), ורשימת הרחובות עם אזור ונקודה (`data/streets.json`, `searchStreets`, `findStreet`). סדר העצירות: `planRoute` (`route.ts`), פונקציה טהורה: עד 8 עצירות בודק את כל הסדרים, מעל זה השכן הקרוב + 2-opt, ועצירות בלי מיקום בסוף. | `packages/shared` | ADR-0001, 0005 |
| **סקריפט רחובות** | חד-פעמי, לא חלק מהאפליקציה: מוריד את הרשימה מ-data.gov.il (`--refresh-list`) וממלא נקודה ואזור לכל רחוב דרך Nominatim, בקשה בשנייה. רחוב ש-OSM לא מכיר מקבל נקודה ידנית: `--point <code> <lat>,<lng>`. אזור לפי `REGION_DIVIDER`. התוצאה נשמרת ב-git. | `scripts/geocode-streets.ts` | ADR-0005 |
| **MongoDB Atlas Free** | אוספים `orders`, `rounds`, `loginAttempts` (TTL). driver רשמי, בלי Mongoose. | AWS us-east-1 | ADR-0001, 0002 |
| **Vercel Hobby** | פרויקט אחד (`latet-od`): ה-build של web ב-CDN, ו-api כ-function ב-`iad1`, ליד Atlas. origin אחד. ה-build, ה-region, ה-rewrites וה-headers ב-`vercel.json`. | `vercel.json` | ADR-0002 |
| **WhatsApp** | `wa.me` עם טקסט מוכן. יואל לוחץ "שלח". מאחורי `MessageSender`. | | ADR-0003 |
| **Waze / חייגן** | `https://waze.com/ul?q=…&navigate=yes`, `tel:`. קישורים בלבד. | | spec §6.4 |
| **גיבוי** | GitHub Actions שבועי (שני 02:17 UTC) ובהפעלה ידנית: `mongodump` עם משתמש read-only, artifact ל-90 יום. מחוץ לאפליקציה. | `.github/workflows/backup.yml` | ADR-0002 |
| **בדיקת smoke** | אחרי כל deploy: כמה GET מול האתר (`/api/health`, 404 של ה-api, תגיות OG, קישור עמוק ל-`/o/...`). לא משנה כלום. | `scripts/smoke.ts` | ADR-0002 |

**אין בזמן ריצה:** geocoding, שירות מסלולים, cron, תורים, או זיכרון משותף בין בקשות. המיקום מגיע מקובץ רחובות סטטי
(OSM, חד-פעמי), וסדר העצירות מחושב בתוך האפליקציה (`planRoute`, קו אוויר).

## פריסה

```mermaid
flowchart LR
    C["לקוח<br/>(דפדפן בטלפון)"]
    Y["יואל<br/>(אפליקציית האוסף)"]
    subgraph V["Vercel: origin אחד"]
        CDN["CDN<br/>apps/web build"]
        F["Function iad1<br/>api/index.js → apps/api (Express)"]
    end
    M[("MongoDB Atlas Free, us-east-1<br/>orders · rounds · loginAttempts")]
    WA["WhatsApp<br/>(wa.me, מהטלפון של יואל)"]
    WZ["Waze"]
    GH["GitHub Actions<br/>גיבוי שבועי"]

    C -->|"/ , /o/token"| CDN
    Y --> CDN
    CDN -.->|"/api/*"| F
    F --> M
    Y -->|"לחיצה על שלח"| WA
    WA --> C
    Y -->|"נווט"| WZ
    GH -->|"mongodump, read-only"| M
```

- `vercel.json`: `/api/*` עובר ב-rewrite ל-function (`api/index.js`), וכל השאר ל-`index.html`. קובץ שקיים ב-build
  (`/assets/*`, `/og-image.jpg`, `/manifest.webmanifest`, האייקונים) מוגש לפני ה-rewrites. `/o/*` מקבל `X-Robots-Tag: noindex`.
  בגלל ה-origin האחד: בלי CORS, ו-cookie עם `SameSite=Lax`.
- **region:** ה-function ב-`iad1`, ליד Atlas ב-us-east-1. הטופס הסטטי מגיע מה-CDN, ורק קריאות ל-api חוצות את האוקיינוס.
- **warm-up:** הטופס שולח `GET /api/health` כשהוא נטען. עד שהלקוח מסיים למלא, ה-function כבר חם.
- בפיתוח: Vite ב-5173 מעביר את `/api` ל-Express ב-3000. אותו מבנה, אותו origin.
- **deploy:** push ל-`main` (באישור בלבד). הצעדים הידניים והבדיקות (משתני סביבה, Atlas, secret של הגיבוי, אבטחה,
  cold start, rollback): `docs/deploy.md`. אחרי כל deploy: `npm run smoke -- https://latet-od.vercel.app` (`scripts/smoke.ts`).
  הגיבוי: `.github/workflows/backup.yml`.

## זרימת הזמנה

```mermaid
sequenceDiagram
    autonumber
    actor L as לקוח
    participant W as web
    participant A as api
    participant D as Mongo
    actor Y as יואל

    L->>W: טופס: שם, טלפון, רחוב מהרשימה, מספר בית, כמות ≥30
    W->>A: POST /api/orders (zod מ-shared)
    A->>D: הזמנה פתוחה אחת לטלפון? אזור לפי הרחוב, token אקראי
    A-->>W: token
    W-->>L: "תודה" + קישור /o/token
    Note over D: status = waiting

    Y->>W: תכנון סבב: תאריך + אזור
    W->>A: POST /api/collector/rounds
    A->>D: ההזמנות → pending
    A-->>W: MessageSender → { mode: manual, url: wa.me/... }
    Y->>L: לוחץ "שלח" ב-WhatsApp (קישור לעמוד ההזמנה)

    L->>W: /o/token → "מאשר/ת איסוף"
    W->>A: POST /api/o/:token/confirm
    A->>D: pending → confirmed

    Y->>W: "סגור אישורים ובנה מסלול"
    A->>D: מי שלא אישר → waiting + lastMiss<br/>planRoute(בית, עצירות, נקודת פריקה) נשמר בסבב
    loop לכל עצירה
        Y->>Y: נווט (Waze) / חייג
        Y->>W: "אספתי" (כמות בפועל) או "לא נמצא"
        A->>D: collected, או waiting + lastMiss
        A-->>W: תודה: קישור wa.me, יואל לוחץ "שלח"
    end
    Y->>W: "סגור סבב"
    W-->>Y: שאלה, ומעליה "תודות שלא נשלחו"<br/>(נאספו, וקישור התודה לא נפתח)
    Y->>W: "כן, לסגור את הסבב"
    W->>A: POST /api/collector/rounds/:id/close
    A->>D: קודם הסבב → closed (כתיבה מותנית)<br/>אחר כך כל הזמנה בו שעוד pending או confirmed → waiting + lastMiss<br/>notReached (סבב routed) או notConfirmed (סבב confirming, למשל בוטל בגלל גשם)<br/>collected, "לא נמצא" ו-cancelled נשארים כמו שהם
    A-->>W: הסבב יוצא מהטאב "סבבים"<br/>סגירה שנייה: הצלחה, ועוברת שוב על ההזמנות
```

הסטטוסים ומעברי הסטטוס: spec §4. בכל שלב עד `collected` הלקוח יכול לבטל או לשנות מעמוד ההזמנה (כפתורים, POST).

**היסטוריה (spec §3.7):** הטאב "היסטוריה" (`collector/HistoryScreen.tsx`) מציג חודש אחד, ברירת המחדל היא החודש הנוכחי,
וכפתורי "החודש הקודם" / "החודש הבא" (אין מעבר לחודש עתידי). הוא קורא ל-`GET /api/collector/history?month=YYYY-MM`
(`apps/api/src/history/collectorHistoryRoutes.ts`, `month` לא תקין: 400). הכללים, ב-`packages/shared`:
- החודש נספר לפי `Asia/Jerusalem`: `monthRangeInAppZone` (`dates.ts`) נותן טווח חצי-פתוח [תחילת החודש, תחילת הבא),
  כך שהזמנה שנאספה ב-23:30 בלילה האחרון של החודש נספרת בו. ה-repo מסנן עם `closedBetween`.
- הזמנה שנאספה שייכת לחודש של `collectedAt`, ובוטלה לחודש של `cancelledAt`. הבוטלות מופיעות ברשימה, אבל לא בשום סכום.
- `buildHistory` (`historyApi.ts`): בקבוקים שנאספו = סכום `bottlesCollected`, "כתובות שנאספו" = מספר ההזמנות שנאספו,
  שווי = בקבוקים × `BOTTLE_VALUE_AGOROT`, באגורות שלמות (`formatShekels` מציג בשקלים). הרשימה מהחדשה לישנה, בלי טלפון ובלי token.

## גבולות בין workspaces

```mermaid
flowchart TB
    web["apps/web"] --> shared["packages/shared"]
    api["apps/api"] --> shared
    web -. "✗ אסור" .-> api
    api -. "✗ אסור" .-> web
    shared -. "✗ אסור: אפליקציות, express, react" .-> web
```

| מ- | מותר לייבא | אסור | נאכף ב- |
|---|---|---|---|
| `apps/web` | `@bottlerun/shared`, React, ספריות דפדפן | `apps/api` | ESLint `no-restricted-imports` |
| `apps/api` | `@bottlerun/shared`, Express, driver של Mongo | `apps/web` | ESLint `no-restricted-imports` |
| `packages/shared` | zod, קוד TS טהור | כל אפליקציה, `express`, `react` | ESLint `no-restricted-imports` |
| `scripts` | `@bottlerun/shared`, Node | כל אפליקציה | ESLint `no-restricted-imports` |
| `api` (ה-function של Vercel) | `apps/api`, Node | `apps/web` | ESLint `no-restricted-imports` |

**מה שייך ל-shared:** כל דבר ששני הצדדים צריכים להסכים עליו: צורת ההזמנה (zod), קודי סטטוס, כללי validation
(טלפון ישראלי, מינימום 30), טקסט ההודעות (`renderMessage`), רשימת הרחובות, ושווי בקבוק.
**מה לא שייך:** גישה ל-DB, סודות, ונקודת ההתחלה (הבית של יואל).

## ממשקים מול העולם החיצון

כל אחד עם fake לבדיקות, כך שהבדיקות לא נוגעות ברשת ולא ב-Atlas:

| ממשק | מימוש אמיתי | fake | ADR |
|---|---|---|---|
| `MessageSender` | `WaMeLinkSender` (MVP), `CloudApiSender` (אם יואל יבחר אוטומטי) | `FakeSender` | 0003 |
| `OrdersRepo`, `RoundsRepo` | MongoDB | בזיכרון | 0001 |
| `AttemptStore` (הגבלת ניסיונות וקצב) | `loginAttempts` ב-Mongo, TTL | בזיכרון | 0004 |
| `DistanceMatrix` | haversine (פונקציה טהורה). OSRM אם יידרש. | haversine | 0005 |

## אבטחה ופרטיות (תקציר)
- עמוד הלקוח: רק עם token אקראי וארוך, אישור וביטול ב-POST (ה-preview של WhatsApp שולח GET).
- האוסף: סיסמה אחת (scrypt hash ב-env), cookie חתום ל-90 יום שמתחדש, בדיקת `Origin` בכל פעולה שמשנה משהו.
- הגבלת קצב ב-Mongo, כי ב-serverless אין זיכרון משותף. הזמנה פתוחה אחת לטלפון, ושדה honeypot.
- בלי תוכן בקשות בלוגים: הלוגים של ה-api רושמים את תבנית ה-route, לא את ה-path. סודות ב-env בלבד (ב-Vercel:
  Environment Variables). ה-request logs של Vercel עצמו כן רושמים כל path, כולל `/o/<token>` (ראה `docs/deploy.md`).

## בדיקות ו"ירוק"
`bash .claude/checks.sh all`: lint (כולל הגבולות), format, types, sec, test, build. פירוט ב-`CLAUDE.md`.
מחוץ לירוק, ידני: ה-deploy, ה-smoke מול האתר האמיתי, בדיקות האבטחה, ה-cold start והאפליקציה המותקנת באייפון (`docs/deploy.md`).
