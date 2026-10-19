# ADR-0002: Hosting: פרויקט Vercel אחד (סטטי ב-CDN + Express כ-function), Atlas, גיבוי ב-GitHub Actions

**סטטוס:** מאושר (2026-10-19: Vercel Hobby, חינם) · **תאריך:** 2026-10-19 · **מחליט:** אני (המפתח)

## הקשר
- **הטופס הציבורי חייב להיטען מהר, גם בכניסה הראשונה אחרי שעות בלי תנועה.** הלקוחות מבוגרים, ומגיעים מלינק ב-WhatsApp.
  המתנה של דקה = לקוח שעוזב.
- תקציב: עד 30 ש"ח בחודש, מקסימום 50, **כולל WhatsApp**. עדיף בלי כרטיס אשראי.
- deploy פשוט (git push), ותחזוקה של אדם אחד.
- ההתחברות היא cookie מסוג httpOnly (ADR-0004). אם האתר וה-API באותו origin, אין CORS ואין cookie צד שלישי.
- פתוח ב-spec: שאלה 4 (hosting, דומיין, לינק קצר) ושאלה 5 (גיבוי).

שער: כ-3.05 ש"ח לדולר (לא אומת לאוקטובר 2026).

## אפשרויות

| | עלות לחודש | כרטיס? | הטופס נטען | שליחת הטופס אחרי שקט | הערות |
|---|---|---|---|---|---|
| **א1. Render Free**, שירות אחד (API + build) | 0 | לרוב לא, לפעמים אימות של $1 [1] | **עד כדקה** (נרדם אחרי 15 דק') [1] | עד כדקה | פסול כמו שהוא |
| **א2. Render Free + ping כל 10 דק'** | 0 | כנ"ל | מהיר | מהיר | 750 שעות מספיקות לשירות אחד 24/7 [1]. לא מצאתי סעיף בתנאים שמתיר או אוסר. עוד חלק זז (שירות ping חיצוני). |
| **א3. Render Starter / Fly.io**, שירות אחד | $7 (כ-21 ש"ח) / כ-$2.19 (כ-7 ש"ח) [2][3] | **כן** | מהיר | מהיר (Fly: כ-2 שניות אם נעצר) | פשוט ויציב, אבל עולה כסף ודורש כרטיס |
| **ב. סטטי נפרד** (Cloudflare Pages) **+ API ב-Render Free** | 0 | לא | **מיידי** | עד כדקה | שני origins: CORS, cookie צד שלישי (`SameSite=None`), ושני deploys |
| **ג. Vercel Hobby, פרויקט אחד:** build של Vite ב-CDN, Express כ-function | 0 | **לא** [4] | **מיידי** (CDN) | cold start קצר (Fluid compute) [5] | origin אחד, deploy אחד. Hobby מוגבל לשימוש לא מסחרי (ראה למטה) |
| **ד. Cloudflare Workers** (static assets + Express דרך `httpServerHandler`) | 0 | לא [6] | מיידי | מהיר, ועוד כ-300ms לחיבור Mongo בכל בקשה [7] | מגבלת 10ms CPU ב-Free. Express+Mongo על Workers חדש יחסית ולא נבדק |

**Vercel ושימוש מסחרי.** לפי ההגדרה של Vercel, שימוש מסחרי הוא deployment ש"משמש לרווח כספי של **מישהו** שמעורב
בייצור הפרויקט", למשל קבלת תשלום מהמבקרים, פרסומות, או תשלום למי שבונה את האתר.
**"בקשת תרומות אינה שימוש מסחרי."** [8] כאן אין תשלום באתר, אין פרסומות, ואף אחד לא מקבל כסף. לדעתי זה בסדר.
אם יש ספק: אפשר לשאול את התמיכה של Vercel.

## החלטה
**אפשרות ג': פרויקט Vercel Hobby אחד.**
- `apps/web` נבנה עם Vite ומוגש סטטית מה-CDN. **הטופס נטען מיד**, בלי קשר למצב השרת.
- `apps/api` הוא אפליקציית Express רגילה (`app.ts` מייצא את `app`). יש לה שתי נקודות כניסה דקות:
  `api/index.ts` ל-Vercel, ו-`server.ts` להרצה מקומית ול-hosting רגיל. **כך המעבר ל-Render או ל-Fly הוא שינוי config, לא קוד.**
- rewrite: `/api/*` הולך ל-function, וכל השאר ל-`index.html` (SPA). origin אחד, ולכן `SameSite=Lax` ובלי CORS.
- **region של ה-function:** `fra1` (ב-Hobby אפשר לבחור region אחד [9]), קרוב לקלאסטר Atlas באירופה.
- **warm-up:** הטופס שולח `GET /api/health` כשהוא נטען. הבדיקה הזו פותחת גם חיבור ל-Mongo. עד שהלקוח מסיים
  למלא (עשרות שניות), ה-function כבר חם. בנוסף: מצב "שולח..." ברור, וניסיון חוזר אחד.
- **חיבור ל-Mongo:** `MongoClient` אחד ברמת המודול, שנשמר בין הפעלות. Atlas Free מאפשר 500 חיבורים [10], הרבה יותר
  ממה שצריך.
- **Network access ב-Atlas:** ל-functions של Vercel אין IP קבוע, ולכן `0.0.0.0/0`, עם משתמש DB שיש לו הרשאות רק
  ל-DB של הפרויקט וסיסמה חזקה.

**דומיין ולינק (שאלה 4):** מתחילים עם תת-דומיין חינמי, למשל `latet-od.vercel.app`. הוא קצר מספיק ללינק בטקסט
ו-QR, ולא צריך שירות לינקים מקוצרים. דומיין `.com` עולה כ-$10.5 בשנה (כ-32 ש"ח, כ-2.7 ש"ח לחודש) [11]. זו החלטה שלך,
ואפשר לקבל אותה גם אחרי ההשקה. תגיות Open Graph (כותרת, תיאור, תמונה עד 300KB) כתובות סטטית ב-`index.html`,
כי ה-preview של WhatsApp לא מריץ JS (לא אומת, אבל ככה זה בטוח).

**גיבוי (שאלה 5):** workflow ב-GitHub Actions, פעם בשבוע ובהפעלה ידנית: `mongodump` (רק בקריאה, עם משתמש read-only),
והתוצאה נשמרת כ-artifact ל-90 יום בריפו הפרטי. זה בחינם (2,000 דקות בחודש לריפו פרטי) [12].
זה לא cron באפליקציה: זה רץ מחוץ לה, ואם הוא נכשל, האפליקציה ממשיכה לעבוד. החלופה (גיבוי של Atlas, $3 לחודש) דורשת
כרטיס, ונמצאת בהפצה מוגבלת [13].

## השלכות
- 👍 0 ש"ח, בלי כרטיס, טופס מיידי, deploy אחד ב-git push, ו-preview deployment לכל ענף.
- 👍 ה-hosting לא "נרדם". אין ping חיצוני, ואין עוד שירות לתחזק.
- 👎 **serverless:** בלי זיכרון משותף בין הפעלות. לכן הגבלת הניסיונות של ההתחברות והגבלת הקצב של הטופס נשמרות
  ב-Mongo (TTL), לא בזיכרון (ADR-0004). בלי תהליכי רקע. זה מתאים ל-spec, שממילא אומר "בלי cron ובלי תורים".
- 👎 ב-Hobby, logs נשמרים שעה אחת בלבד [4]. אם יש תקלה, צריך לבדוק מהר, או לשמור שגיאות ב-Mongo.
- 👎 אם עוברים את המכסה ב-Hobby, הפיצ'ר מושבת ל-30 יום [4]. בנפח שלנו זה רחוק מאוד (1M הפעלות בחודש).
- 👎 אם Vercel יחליט שהפרויקט מסחרי: עוברים ל-Fly.io (כ-7 ש"ח בחודש, עם כרטיס) או ל-Render Starter (כ-21 ש"ח).
  הקוד לא משתנה, בזכות `server.ts`.
- 🔁 לבדוק cold start אמיתי של שליחת הטופס אחרי לילה שקט, אחרי ה-deploy הראשון (P4 section 10).

## מקורות
1. https://render.com/docs/free, https://community.render.com/t/free-but-credit-card-first/24630
2. https://render.com/pricing (המחיר $7 לא נשלף ישירות מהעמוד. אומת דרך צד שלישי)
3. https://docs.fly.io/about/pricing, https://docs.fly.io/launch/autostop-autostart
4. https://vercel.com/docs/plans/hobby (עודכן 2026-09-14)
5. https://vercel.com/docs/fluid-compute, https://vercel.com/kb/guide/improve-function-cold-start-performance-on-vercel
6. https://developers.cloudflare.com/workers/platform/pricing/
7. https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/
8. https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage
9. https://vercel.com/docs/functions/configuring-functions/region ("Hobby: Single region")
10. https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
11. https://domainoffer.net/tld/com/cloudflare (צד שלישי)
12. https://docs.github.com/en/billing/concepts/product-billing/github-actions
13. https://www.mongodb.com/docs/atlas/backup/cloud-backup/free-cluster-backup/
