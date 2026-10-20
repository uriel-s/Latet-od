# Deploy: פרויקט Vercel `latet-od`

הצעדים הידניים של ה-deploy, והבדיקות שעושים אחריו. הפרויקט ב-Vercel כבר קיים: המסמך מתאר אותו, לא איך יוצרים חדש.
ההחלטות עצמן: ADR-0002 (`docs/decisions/0002-hosting.md`).
שום דבר כאן לא נבדק ב-`bash .claude/checks.sh all`: ה-deploy, משתני הסביבה, Atlas וה-cold start הם ידניים.

**פרטיות:** במסמך הזה אין ערכים אמיתיים, ולא מוסיפים אותם: לא סיסמאות, לא connection strings, לא hash, לא הכתובת
של יואל ולא הטלפון שלו. רק placeholders כמו `<user>`, `<password>`, `<cluster>`.

## 1. מה כבר קיים

**פרויקט Vercel `latet-od`.** נוצר ב-2026-10-20, תוכנית Hobby, מחובר לריפו ב-GitHub.

| הגדרה בממשק של Vercel | ערך |
|---|---|
| Root Directory | `./` |
| Framework Preset | Vite |
| Build Command | `npm run build --workspace apps/web` |
| Output Directory | `apps/web/dist` |
| כתובת production | `https://latet-od.vercel.app` (זה גם `PUBLIC_BASE_URL`) |

- **כל push ל-`main` הוא deploy ל-production.** push לענף אחר יוצר preview deployment (ראה סעיף 3, על preview).
- **`vercel.json` בשורש הריפו גובר על ההגדרות שבממשק.** משנים שם, לא בממשק. מה יש בו:
  - `buildCommand` ו-`outputDirectory`: אותם ערכים כמו בטבלה, כדי שהריפו יהיה המקום היחיד שבו הם כתובים.
  - `regions: ["iad1"]`: ה-function רץ ב-Washington, D.C., ליד הקלאסטר של Atlas ב-AWS us-east-1 (סעיף 4).
    הקלאסטר נשאר שם בהחלטת המפתח.
  - `rewrites`, לפי הסדר: קודם `/api/(.*)` ל-function (`api/index.ts`), ואז כל השאר ל-`index.html` (SPA).
    קובץ שקיים ב-build (`/assets/*`, `/og-image.jpg`) מוגש לפני כל rewrite.
    הסדר חשוב: אם ה-SPA יבוא קודם, כל קריאה ל-api תקבל `index.html`.
  - header: `X-Robots-Tag: noindex` על `/o/*`, כדי שעמודי ההזמנה הפרטיים לא ייכנסו למנועי חיפוש. הטופס ב-`/` נשאר גלוי.
- **ה-function: `api/index.ts`.** הוא מייצא רק `createVercelHandler(() => depsFromEnv(process.env))`.
  האפליקציה נבנית בבקשה הראשונה. לכן env לא תקין עונה 500 ב-JSON עם שורת לוג ברורה, ולא דף שגיאה של Vercel.
  כל קובץ `.ts` בתיקייה `api/` הופך ל-function, ולכן אין בה שום דבר אחר.
  `apps/api/src/server.ts` נשאר להרצה מקומית (`npm run dev:api`). שתי הכניסות בונות את התלויות עם `depsFromEnv`.
- **push ל-`main` = deploy ל-production. לכן הוא קורה רק באישור מפורש של המפתח.**
  הדרך הרגילה: merge מקומי ל-`main`, ואז push. ה-hook חוסם push ל-`main`, ולכן צריך פעם אחת בכל clone:

  ```bash
  git config core.hooksPath .githooks       # מפעיל את ה-hook שחוסם push ל-main
  git config claude.allowTrunkPush true     # רק ב-clone שבו עושים merge מקומי ודוחפים את main
  ```

## 2. חוסמים לפני ה-deploy האמיתי הראשון

- [ ] **S5: פרץ מקביל של סיסמאות שגויות עובר את הגבלת ההתחברות.**
      ב-`apps/api/src/auth/authRoutes.ts` הסדר הוא: בודקים את המונה, מריצים scrypt, ורק אז רושמים את הכישלון.
      כמה בקשות שנשלחות באותו רגע עוברות כולן את הבדיקה, לפני שהראשונה נרשמה.
      זה רשום ל-`/dev-finish`, יחד עם החלטת המפתח להוריד את מינימום הסיסמה ל-8 תווים (היום `hash-password` דורש 16).
      **שניהם חייבים להיכנס לפני ה-deploy האמיתי הראשון.** לא תוקן ב-section הזה.
- [ ] **`COLLECTOR_PASSWORD_HASH` עוד לא מוגדר ב-Vercel.**
      `depsFromEnv` בודק את כל המשתנים, ולכן בלעדיו **כל ה-api** עונה 500 (`{"error":"internal"}`),
      ובלוג של ה-function יש אירוע `invalid_env` עם שם המשתנה.
      זה לא רק ההתחברות: גם הטופס הציבורי לא יכול לשלוח הזמנה.
      איך מייצרים: סעיף 3. אם הסיסמה של יואל קצרה מ-16 תווים, מייצרים את ה-hash אחרי שהמינימום ירד ל-8.

## 3. משתני סביבה ב-Vercel

Settings → Environment Variables, בסביבה **Production**. ההסבר המלא לכל משתנה: `apps/api/.env.example`.

| משתנה | מצב | הערות |
|---|---|---|
| `MONGODB_URI` | מוגדר | המשתמש של האפליקציה ב-Atlas: `readWrite` על `bottlerun` בלבד (סעיף 4). ה-path חייב לכלול את שם ה-DB: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/bottlerun?retryWrites=true&w=majority`. בלי `/bottlerun` ה-api מסרב לעלות. |
| `SESSION_SECRET` | מוגדר | לפחות 32 תווים, ושונה מזה שב-`.env` המקומי. החלפה שלו מנתקת כל מכשיר (למשל אם הטלפון של יואל אבד). |
| `COLLECTOR_PASSWORD_HASH` | **חסר** | מייצרים עם `npm run -s hash-password --workspace apps/api` (פרטים ב-`.env.example`). מדביקים רק את ה-hash, `scrypt$<salt>$<hash>`, כמו שהוא: בלי מרכאות, ואף פעם לא את הסיסמה עצמה. |
| `PUBLIC_BASE_URL` | מוגדר | `https://latet-od.vercel.app`, בלי path. כל קישור בהודעות WhatsApp נבנה ממנו. |
| `MESSAGE_SENDER` | מוגדר | `wame`. |
| `NODE_ENV` | לא מגדירים | Vercel קובע `production` בעצמו. **אסור `development`:** ה-cookie של ההתחברות יאבד את `Secure`. |
| `ROUTE_START` | עוד לא | נכנס עם section המסלול. פרטי (הבית של יואל): רק ב-env, אף פעם לא בקוד ולא במסמכים. |

`PORT` לא צריך ב-Vercel: רק `server.ts` קורא אותו.

- **שינוי במשתנה נכנס לתוקף רק אחרי deploy חדש:** Deployments → ה-deployment האחרון → Redeploy.
- **המשתנים מוגדרים ל-Production בלבד.** ב-preview deployment ה-api יענה 500 `invalid_env`.
  בנוסף, ב-Hobby ה-previews בדרך כלל מאחורי Vercel Authentication, ועונים 401 לכל מי שלא מחובר ל-Vercel בדפדפן.
  לכן `scripts/smoke.ts` מיועד ל-production.
- אפשר להוסיף את המשתנים גם ל-Preview, אבל אז כל preview עובד מול ה-DB האמיתי: ענף ניסיוני יכול לכתוב נתונים אמיתיים.
  רק בכוונה, ואחרי מחשבה.

## 4. Atlas

- **הקלאסטר ב-AWS us-east-1, ולכן ה-function ב-`iad1` (Washington, D.C.).**
  האתר הסטטי (הטופס) מגיע מה-CDN של Vercel, קרוב לכל מקום. רק הקריאות ל-api חוצות את האוקיינוס:
  כ-150ms לכל הלוך-חזור מישראל. זה מקובל.
- **Network Access: `0.0.0.0/0`.** ל-functions של Vercel ולמכונות של GitHub Actions אין IP קבוע (ADR-0002).
  לכן ההגנה היא משתמשי DB עם הרשאות מינימליות וסיסמאות חזקות. יש שניים
  (Database Access → המשתמש → Specific Privileges, לא Atlas admin ולא "any database"):

| משתמש | הרשאה | איפה ה-URI שלו |
|---|---|---|
| של האפליקציה | `readWrite` על `bottlerun` בלבד | `MONGODB_URI` ב-Vercel |
| של הגיבוי | `read` (role מובנה) על `bottlerun` בלבד | `MONGODB_BACKUP_URI` ב-GitHub (סעיף 5) |

- [ ] אחרי ה-deploy הראשון: לבדוק ב-Vercel שה-region של ה-function הוא `iad1`
      (Settings → Functions, או בפרטי ה-function ב-deployment).

## 5. GitHub: גיבוי

ה-workflow: `.github/workflows/backup.yml`. `mongodump` של `bottlerun` עם המשתמש של הגיבוי (קריאה בלבד),
והתוצאה נשמרת כ-artifact ל-90 יום.

- [ ] **Secret:** ב-GitHub, Settings → Secrets and variables → Actions → New repository secret:
      `MONGODB_BACKUP_URI` = `mongodb+srv://<backup-user>:<password>@<cluster>.mongodb.net/bottlerun`
      (המשתמש של הגיבוי מסעיף 4, וה-path הוא שם ה-DB).
- **מתי הוא רץ:** כל יום שני ב-02:17 UTC, ובהפעלה ידנית. **אבל רק אחרי שהקובץ נמצא ב-`main`:**
  GitHub מריץ schedule ומציג את הכפתור Run workflow רק מה-branch הראשי.
- **ריצה שנכשלה:** GitHub שולח מייל. אין צורך בעוד התראה.

### ריצה ראשונה
- [ ] Actions → backup → Run workflow.
- [ ] בלוג של הריצה: השורה של `ls -l` מראה את גודל הקובץ. קובץ קטן מאוד = משהו לא בסדר.
- [ ] בעמוד הריצה, תחת Artifacts: `mongodump-<תאריך>` (נשמר 90 יום).
- [ ] לבדוק אם ל-`actions/upload-artifact` יש major חדש מ-v4 (בגלל סוף התמיכה ב-Node 20). אם כן, לעדכן בענף.

### שחזור (לבדוק פעם אחת, לפני שצריך)
1. מורידים את ה-artifact (zip) מעמוד הריצה, ופותחים אותו: בפנים `bottlerun.archive.gz`.
2. **משחזרים קודם ל-MongoDB מקומי**, לא ל-Atlas. ב-Docker, בתיקייה של הקובץ:

   ```bash
   docker run -d --name restore-test -p 27017:27017 mongo:8.0
   # אם MongoDB Database Tools מותקנים במחשב:
   mongorestore --uri="mongodb://localhost:27017" --gzip --archive=bottlerun.archive.gz
   # או בלי להתקין כלום, מתוך הקונטיינר. ב-Git Bash צריך MSYS_NO_PATHCONV=1, אחרת הוא משנה את הנתיבים:
   MSYS_NO_PATHCONV=1 docker cp bottlerun.archive.gz restore-test:/restore.archive.gz
   MSYS_NO_PATHCONV=1 docker exec restore-test mongorestore --gzip --archive=/restore.archive.gz
   ```

3. בודקים שהאוספים של `bottlerun` והכמויות נראים נכון:

   ```bash
   docker exec restore-test mongosh --quiet bottlerun --eval 'db.getCollectionNames().forEach(c => print(c, db[c].countDocuments()))'
   docker rm -f restore-test       # בסוף הבדיקה
   ```

4. **שחזור אמיתי ל-Atlas:** רק אחרי מחשבה שנייה. עם המשתמש של האפליקציה (למשתמש של הגיבוי אין הרשאת כתיבה),
   ועם `--drop`, ש**מחליף** את האוספים הקיימים:
   `mongorestore --uri="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/" --nsInclude="bottlerun.*" --gzip --archive=bottlerun.archive.gz --drop`.
   כל מה שנכתב אחרי הגיבוי הולך לאיבוד.

## 6. ה-deploy עצמו

- [ ] החוסמים בסעיף 2 סגורים, ומשתני הסביבה בסעיף 3 מוגדרים.
- [ ] `bash .claude/checks.sh all` ירוק בענף.
- [ ] merge מקומי ל-`main` ו-push. **רק באישור המפתח.**
- [ ] Vercel → Deployments: ה-build עבר (Ready).
- [ ] `npm run smoke -- https://latet-od.vercel.app`. מצפים ל-4 שורות OK (`health`, `api-404`, `open-graph`, `spa-deep-link`)
      ו-`all 4 checks passed`. רושמים את הזמן של `health` (`in N ms`).
- [ ] ה-region הוא `iad1` (סעיף 4).
- [ ] בדיקות האבטחה (סעיף 7) ו-preview ב-WhatsApp (סעיף 8).
- [ ] הזמנת בדיקה מהטלפון שלך, עם המספר שלך: מגיעים למסך התודה, נכנסים לעמוד ההזמנה, ומבטלים אותה משם.

### מה אומר כישלון של ה-smoke

| מה נכשל | מה זה אומר | מה בודקים |
|---|---|---|
| `health` עונה 500 | env לא תקין: ה-api לא עלה | הלוגים של ה-function ב-Vercel: אירוע `invalid_env` עם שם המשתנה (סעיף 3) |
| `health` עונה 503 | ה-function רץ, אבל לא מגיע ל-Atlas | Network Access ב-Atlas, ו-`MONGODB_URI` (משתמש, סיסמה, `/bottlerun`) |
| `api-404` מקבל HTML | ה-SPA תפס נתיב של api | הסדר של ה-rewrites ב-`vercel.json`: `/api/(.*)` ראשון |
| `open-graph` | חסרה תגית OG, או שהתמונה לא נמצאת / גדולה מ-300KB | `apps/web/index.html`, `apps/web/public/og-image.jpg` |
| `spa-deep-link` | `/o/...` לא מחזיר את `index.html`, או שאין `X-Robots-Tag` | ה-rewrites וה-headers ב-`vercel.json` |
| הכל 401 | deployment protection (כנראה preview) | להריץ מול production |

### לא נבדק לפני ה-deploy הראשון
ה-api הוא קוד TypeScript עם import של קבצי `.ts`, ו-`packages/shared` נצרך כ-TS בלי build.
Node 24 מריץ את זה כמו שזה (נבדק מקומית: import של `api/index.ts` עובד).
**לא נבדק איך ה-builder של Vercel ל-Node אורז את זה.**
אם ה-function לא נטען (למשל `FUNCTION_INVOCATION_FAILED`, `ERR_MODULE_NOT_FOUND`, או שגיאה על קובץ `.ts`):
עושים rollback (סעיף 10), ומתקנים בענף, למשל bundle של ה-function בזמן ה-build. **לא מתקנים ישירות על `main`.**

## 7. בדיקות אבטחה אחרי ה-deploy הראשון

- [ ] **X-Forwarded-Host חייב לבוא מ-Vercel, לא מהלקוח.**
      ה-api סומך על proxy אחד (`trust proxy` = 1). בדיקת ה-Origin משווה את `Origin` ל-`req.host`,
      ומאחורי proxy זה ה-X-Forwarded-Host. אם Vercel מעביר את ה-header של הלקוח, אפשר לעקוף את הגנת ה-CSRF.

  ```bash
  curl -i -X POST https://latet-od.vercel.app/api/auth/logout \
    -H "Origin: https://evil.example" -H "X-Forwarded-Host: evil.example"
  ```

  צריך לענות **403** (`{"error":"forbidden_origin"}`).
  **204 = Vercel העביר את ה-header של הלקוח, ואפשר לעקוף את בדיקת ה-CSRF: עוצרים ומתקנים לפני שעולים לאוויר.**
  בדיקת ביקורת: אותה בקשה עם `-H "Origin: https://latet-od.vercel.app"` ובלי X-Forwarded-Host צריכה לענות 204.
  403 שם = גם הבקשות של האתר עצמו ייחסמו (הטופס לא ישלח).
- [ ] **X-Forwarded-For.** לפי התיעוד של Vercel, הוא דורס אותו עם ה-IP של הלקוח. מאמתים פעם אחת:
      ממחשב אחד, 6 התחברויות שגויות, כל אחת עם X-Forwarded-For אחר.

  ```bash
  for n in 1 2 3 4 5 6; do
    curl -s -o /dev/null -w "%{http_code}\n" -X POST https://latet-od.vercel.app/api/auth/login \
      -H "Origin: https://latet-od.vercel.app" -H "Content-Type: application/json" \
      -H "X-Forwarded-For: 203.0.113.$n" -d '{"password":"not-the-real-password"}'
  done
  ```

  מצפים ל-401 חמש פעמים, ואז **429** (המגבלה ל-IP: 5 כישלונות ב-15 דקות).
  **שש פעמים 401 = המגבלה נשענת על header שהלקוח שולט בו: עוצרים ומתקנים.**
  זהירות: הבדיקה נועלת התחברות מה-IP שלך ל-15 דקות, ונספרת גם במגבלה הכללית (30 כישלונות בשעה מכל ה-IPs).
  עושים אותה כשיואל לא צריך להתחבר.
- **IPv6 (מגבלה ידועה, להמשך):** המפתח של הגבלת הקצב הוא כתובת ה-IP המלאה. לקוח עם IPv6 מקבל בדרך כלל /64 שלם,
  ויכול להחליף כתובות ולעקוף את המגבלות ל-IP: של הטופס (10 בשעה) ושל ההתחברות (5 ב-15 דקות).
  המגבלה הכללית של ההתחברות עדיין עובדת. תיקון אפשרי: לספור כתובת IPv6 לפי ה-/64 שלה.
- **פרטיות הלוגים:** ה-request logs של Vercel רושמים כל path, כולל `/o/<token>` ו-`/api/o/<token>`.
  ה-token הוא המפתח לעמוד של לקוח. כל מי שיש לו גישה לפרויקט ב-Vercel רואה אותם (ב-Hobby הם נשמרים כשעה, ADR-0002).
  לכן: לא מוסיפים אנשים לפרויקט, ולא מעתיקים לוגים החוצה.
  הלוגים של ה-api עצמו אף פעם לא כותבים את ה-path: `errors.ts` רושם רק את התבנית (`/api/o/:token`).

## 8. בדיקת ה-preview ב-WhatsApp

- [ ] שולחים לעצמך ב-WhatsApp את `https://latet-od.vercel.app`. מצפים לכותרת "לתת עוד: איסוף בקבוקים בבית שמש"
      ולתמונה: החלק העליון של הפלאייר, בלי מספר טלפון.
- WhatsApp שומר previews ב-cache. אחרי שינוי בודקים עם `https://latet-od.vercel.app/?v=2` (ו-3, 4...).
- כתובות ה-OG ב-`apps/web/index.html` מלאות (absolute). אם מוסיפים דומיין משלנו, משנים אותן יחד עם
  `PUBLIC_BASE_URL`, ועושים Redeploy.

## 9. בדיקת cold start אחרי לילה שקט

ה-🔁 של ADR-0002: כמה זמן לוקחת שליחת הטופס כשה-function "קר".

- [ ] אחרי 8 שעות ומעלה בלי תנועה (למשל מוקדם בבוקר, לפני שמישהו נכנס לאתר):
      בטלפון, **על גלישה סלולרית** (לא Wi-Fi), פותחים את הטופס, ממלאים, לוחצים "שלח",
      ומודדים מהלחיצה ועד מסך התודה. זו הזמנה אמיתית: מבטלים אותה אחר כך מעמוד ההזמנה.
- [ ] גם `npm run smoke -- https://latet-od.vercel.app` מיד אחרי תקופה שקטה: שורת ה-`health` מראה את הזמן של בקשה קרה.
      בבוקר אחר מבדיקת הטלפון: כל בקשה מחממת את ה-function, והבדיקה השנייה כבר לא תהיה קרה.

| תאריך | מהלחיצה ועד מסך התודה | `health` (ms) | הערות |
|---|---|---|---|
| | | | |

אם זה איטי (יותר מכמה שניות): האפשרויות ב-ADR-0002. ה-warm-up כבר קיים: הטופס שולח `GET /api/health` כשהוא נטען.

## 10. Rollback

- Vercel → Deployments → ה-deployment הקודם של production → Instant Rollback (או Promote to Production).
  ב-Hobby, לפי התיעוד של Vercel, אפשר לחזור רק ל-deployment הקודם.
- אחרי Instant Rollback, Vercel מפסיק לקדם אוטומטית deployments חדשים של `main` ל-production,
  עד שמבטלים את ה-rollback (Undo Rollback) או מקדמים את ה-deployment המתוקן (Promote).
- **משתני הסביבה לא חוזרים אחורה עם ה-deployment.** אם הבעיה הייתה במשתנה, מתקנים אותו ב-Settings → Environment Variables,
  ועושים Redeploy.
