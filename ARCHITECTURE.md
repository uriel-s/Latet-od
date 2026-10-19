# ארכיטקטורה: BottleRun ("לתת עוד")

> מסכם את `docs/spec.md` ואת `docs/decisions/` (ADRs 0001-0005). איפה שיש סתירה, ה-ADR קובע.
> מצב נוכחי: שלד בלבד (P3). מה שמסומן _(P4)_ עוד לא קיים בקוד.

## רכיבים

| רכיב | מה | איפה | החלטה |
|---|---|---|---|
| **web** | SPA ב-React + Vite. שלושה חלקים: טופס ציבורי (`/`), עמוד הזמנה של הלקוח (`/o/<token>`), אפליקציית האוסף (אחרי התחברות). | `apps/web` | ADR-0001 |
| **api** | Express. `app.ts` מייצא את האפליקציה, ויש שתי נקודות כניסה דקות: `server.ts` (מקומי / hosting רגיל), ו-function ל-Vercel _(P4)_. | `apps/api` | ADR-0001, 0002 |
| **shared** | קוד TS שנצרך ישירות, בלי build: טיפוסים, סכמות zod, `renderMessage`, קבועים (שווי בקבוק), ורשימת הרחובות עם אזור ונקודה (`data/streets.json`, `searchStreets`, `findStreet`). | `packages/shared` | ADR-0001, 0005 |
| **סקריפט רחובות** | חד-פעמי, לא חלק מהאפליקציה: מוריד את הרשימה מ-data.gov.il (`--refresh-list`) וממלא נקודה ואזור לכל רחוב דרך Nominatim, בקשה בשנייה. אזור לפי `REGION_DIVIDER`. התוצאה נשמרת ב-git. | `scripts/geocode-streets.ts` | ADR-0005 |
| **MongoDB Atlas Free** | אוספים `orders`, `rounds`, `loginAttempts` (TTL). driver רשמי, בלי Mongoose. | אירופה | ADR-0001 |
| **Vercel Hobby** | פרויקט אחד: ה-build של web ב-CDN, ו-api כ-function ב-`fra1`. origin אחד. | | ADR-0002 |
| **WhatsApp** | `wa.me` עם טקסט מוכן. יואל לוחץ "שלח". מאחורי `MessageSender`. | | ADR-0003 |
| **Waze / חייגן** | `https://waze.com/ul?q=…&navigate=yes`, `tel:`. קישורים בלבד. | | spec §6.4 |
| **גיבוי** | GitHub Actions שבועי: `mongodump` עם משתמש read-only, artifact ל-90 יום. מחוץ לאפליקציה. _(P4)_ | | ADR-0002 |

**אין בזמן ריצה:** geocoding, שירות מסלולים, cron, תורים, או זיכרון משותף בין בקשות. המיקום מגיע מקובץ רחובות סטטי
(OSM, חד-פעמי), וסדר העצירות מחושב בתוך האפליקציה (`planRoute`, קו אוויר).

## פריסה

```mermaid
flowchart LR
    C["לקוח<br/>(דפדפן בטלפון)"]
    Y["יואל<br/>(אפליקציית האוסף)"]
    subgraph V["Vercel: origin אחד"]
        CDN["CDN<br/>apps/web build"]
        F["Function fra1<br/>apps/api (Express)"]
    end
    M[("MongoDB Atlas Free<br/>orders · rounds · loginAttempts")]
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

- `/api/*` עובר ב-rewrite ל-function, וכל השאר ל-`index.html`. בגלל ה-origin האחד: בלי CORS, ו-cookie עם `SameSite=Lax`.
- **warm-up:** הטופס שולח `GET /api/health` כשהוא נטען. עד שהלקוח מסיים למלא, ה-function כבר חם.
- בפיתוח: Vite ב-5173 מעביר את `/api` ל-Express ב-3000. אותו מבנה, אותו origin.

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
    W->>A: POST /api/rounds
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
    Y->>W: "סגור סבב": עצירות שלא סומנו → waiting
```

הסטטוסים ומעברי הסטטוס: spec §4. בכל שלב עד `collected` הלקוח יכול לבטל או לשנות מעמוד ההזמנה (כפתורים, POST).

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
- בלי תוכן בקשות בלוגים. סודות ב-env בלבד.

## בדיקות ו"ירוק"
`bash .claude/checks.sh all`: lint (כולל הגבולות), format, types, sec, test, build. פירוט ב-`CLAUDE.md`.
