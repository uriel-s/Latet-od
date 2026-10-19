# ADR-0001: Stack: TypeScript מקצה לקצה, React+Vite, Express, MongoDB Atlas

**סטטוס:** מוצע · **תאריך:** 2026-10-19 · **מחליט:** אני (המפתח)

## הקשר
- מפתח ומתחזק אחד. העדיפויות: עלות אפס או קרובה לאפס, מינימום חלקים זזים, תחזוקה קלה (spec §7).
- נפח זעיר: כ-1.5 הזמנות ביום, משתמש מחובר אחד. שום שיקול של scale.
- צריך לוגיקה בצד השרת: token אקראי לעמוד ההזמנה, מעברי סטטוס, אכיפה של "הזמנה פתוחה אחת לטלפון",
  ושליחת WhatsApp (אם תהיה אוטומטית).
- ברירת המחדל מ-v1 ומ-P3: TS, React+Vite, Express, MongoDB, npm workspaces. מחליפים רק אם יש סיבה טובה.

## אפשרויות

| | א. Express + MongoDB Atlas (ברירת מחדל) | ב. Supabase | ג. Firebase |
|---|---|---|---|
| עלות | Atlas Free: 0, בלי כרטיס, 512MB [1] | Free: 0, 500MB [2] | Spark: 0 [3] |
| לוגיקת שרת | Express רגיל, בכל hosting | Edge Functions (Deno) או RLS ב-Postgres | **Cloud Functions לא זמינות ב-Spark.** צריך Blaze, כלומר חשבון חיוב [3] |
| השהיה כשאין פעילות | הקלאסטר נעצר אחרי **30 יום** בלי שום חיבור [1] | הפרויקט נעצר אחרי **כ-7 ימים** של פעילות נמוכה [2] | לא |
| גיבוי בחינם | אין גיבוי מובנה בחינם (ראה ADR-0002) | אין [2] | ייצוא ידני |
| נעילה לספק | נמוכה: Express ו-driver רגילים | בינונית: Auth, RLS, ו-API של הספק | גבוהה |
| בדיקות עם fake | פשוט: repository מאחורי ממשק | צריך Supabase מקומי (Docker) או mocks | Emulator |
| היכרות | גבוהה (gazhan, v1) | נמוכה | נמוכה |

## החלטה
**אפשרות א'**, כמו ברירת המחדל:
- **npm workspaces:** `apps/web` (React+Vite), `apps/api` (Express), `packages/shared` (טיפוסים ו-zod).
  `shared` נצרך כ-TS ישירות, בלי build.
- **MongoDB Atlas Free**, באזור אירופי (Frankfurt, אם הוא זמין ל-Free. לבדוק ב-UI של Atlas [4]).
- **ה-driver הרשמי של MongoDB, בלי Mongoose.** zod ב-`shared` הוא המקור היחיד לצורת הנתונים: אותה סכמה מאמתת את הטופס
  ב-web, את הבקשה ב-api, ואת מה שנקרא מה-DB. Mongoose היה מוסיף סכמה שנייה שצריך לסנכרן, ומאריך את ה-cold start.
- גישה ל-DB רק דרך repositories (`OrdersRepo`, `RoundsRepo`) עם fake בזיכרון לבדיקות.
- אוספים: `orders`, `rounds`, ועוד `loginAttempts` (ADR-0004). בלי `users` (ADR-0004), ובלי `customers`:
  לקוח חוזר מזוהה לפי הטלפון ב-`orders`, וההגדרות בקוד (ADR-0005).

**למה לא Supabase:** ההשהיה אחרי שבוע היא סיכון ממשי. בתקופה שקטה (חגים, חופש של יואל) הטופס הציבורי פשוט יפסיק לעבוד.
גם RLS ו-Deno הם עוד דברים ללמוד ולתחזק לבד.
**למה לא Firebase:** בלי Functions ב-Spark, כל הלוגיקה צריכה לרוץ בדפדפן ולהיאכף ב-security rules. זה לא מתאים
ל-token אישי, למעברי סטטוס ולשליחת הודעות. Blaze דורש כרטיס.

## השלכות
- 👍 קוד רגיל שרץ בכל hosting של Node. אם ה-hosting מ-ADR-0002 נסגר או משנה תנאים, עוברים בלי לכתוב מחדש.
- 👍 סכמה אחת (zod) לשלוש השכבות.
- 👎 בלי Mongoose אין `populate` ו-middleware. בנפח ובמודל הזה (2 אוספים עיקריים) לא צריך אותם.
- 👎 Atlas Free עוצר אחרי 30 יום בלי חיבור. בנפח הנוכחי זה לא קורה, אבל אחרי הפסקה ארוכה צריך לבדוק שהאתר עובד.
- 🔁 לחזור לזה רק אם מוסיפים ערים או אוספים (מחוץ ל-MVP).

## מקורות
1. https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ (512MB, השהיה אחרי 30 יום), https://www.mongodb.com/cloud/atlas/register ("No credit card required")
2. https://supabase.com/pricing, https://supabase.com/docs/guides/platform/free-project-pausing
3. https://firebase.google.com/pricing
4. https://www.mongodb.com/docs/atlas/reference/amazon-aws/ (לא אומת אם Frankfurt ותל אביב זמינים ל-Free)
