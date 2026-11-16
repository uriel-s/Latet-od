# העברה: כללי פרופורציה ב-CLAUDE.md

> קובץ זמני. למחוק לפני ה-merge.
> branch: `docs/claude-md-proportion` (4 קומיטים, כלל לקומיט). עדיין לא מוזג.

## מה נעשה

נוספו לקובץ CLAUDE.md ארבעה כללים, כדי לבלום הנדסת-יתר של סוכני AI:
1. סעיף "Proportion".
2. הערות קצרות.
3. איסור על כתיבה ידנית של פרוטוקולי אבטחה.
4. בדיקות לפי סיכון.

אחר כך הריצו עליהם `/red-team` עם 3 סקפטיים. **אף כלל לא נפסל, אבל כל אחד מהם צריך ניסוח מחדש לפני ה-merge.**

## מה צריך לעשות: לנסח מחדש ב-CLAUDE.md (נוסח מוצע)

### כלל 1: Proportion
- שורת ההיקף: לציין שזו הערכה, מ-ADR-0001 ("about 1.5 orders a day (ADR-0001's estimate)").
- להוסיף לבולט "has this happened":
  > This does not apply to security, privacy or data integrity: guards such as rate limits, `$eq`, unique indexes and conditional writes stay, and new code gets them before any incident. An interface with a fake for an external call (Rules) is required, not optional.
- להחליף את בולט המחיקה:
  > Removing code or a comment is as welcome as adding, within the files the task touches. Propose larger removals (files, documents, ADRs) instead of doing them unasked. A review names what can be deleted.
- **למחוק** את בולט ה-refactoring. הוא לא מגביל כלום, כי סוכן תמיד ימצא סיבה לכתוב.
- בסוף בולט ה-ADR להוסיף: "A behaviour change that contradicts the spec updates `docs/spec.md`."

### כלל 2: הערות
**הסיכון:** "not the history" יחד עם "fewer" יגרמו לסוכן למחוק הערות שמגנות על שמות שמורים ב-MongoDB:
- `round.ts:30`
- `messages.ts:72`
- `roundsApi.ts:453`
- `round.ts:87`

אחרי שההערה נמחקת, הסוכן "מתקן" את השם, וזה שובר נתונים קיימים. אותו דבר עם הערת ה-`$eq`.

**הנוסח המוצע** (למזג גם את בולטי ה-module header וה-JSDoc לבולט האורך):
> - Comment the *why* only: business rules, workarounds, assumptions. Not the obvious *what*, and not history for its own sake. Keep any comment that explains why something must not change: a stored name or legacy value, a deviation from an ADR, a security guard (`$eq`), or the order of steps.
> - Keep comments short, usually one to three lines (module headers and JSDoc too); longer only for a non-obvious algorithm, order of steps or business rule.
> - When you change code, fix or shorten the comments on the lines you changed; leave the rest of the file alone. Never delete a comment of the kinds above.

### כלל 3: תלויות (הכלל המסוכן ביותר)
**הבעיה:** כמו שהוא מנוסח עכשיו, הכלל מגדיר כהפרה קוד שאושר ב-ADR:
- `webPushSender.ts` (ADR-0013)
- `session.ts` (ADR-0004)
- `cookies.ts`
- `dates.ts`
- `phone.ts`

**הנוסח המוצע:**
> 2. Prefer no dependency when a built-in does the job (`node:crypto` scrypt instead of bcrypt, ADR-0004). But in new code, never hand-write cryptography (encryption, signatures, Web Push/VAPID) or time-zone arithmetic: use the well-known library. Calling a built-in primitive directly is fine (scrypt, an HMAC over a payload, `Intl` with `timeZone`). Existing hand-written code (`webPushSender.ts`, ADR-0013; `session.ts`, ADR-0004) stays until a task of its own replaces it and amends the ADR; never touch it during unrelated work.

### כלל 4: בדיקות לפי סיכון
**הבעיה:** הכלל סותר את הבולט האחרון ב-Testing Conventions ("Happy path first, then edges…"), ויש שתי רשימות סיכון שונות.

**התיקון:**
- להחזיר את שלב 4 ב-Workflow לנוסח המקורי ("Tests with every change." בלבד).
- להחליף את הבולט האחרון ב-Testing Conventions:
  > Happy path first. Edge cases only where a break hurts: bottle counts (minimum 20), messages to customers and the phone format behind them, one open order per phone, data loss, privacy and access (expired/forged token), abuse limits (login and booking rate limits), status transitions that must be refused. Elsewhere one happy-path test is enough; a missing edge case outside this list is not a review finding. Do not delete existing tests in a task that is not about them.

## מחוץ ל-CLAUDE.md: החלטות נפרדות (לא לעשות בלי אישור)

1. **קדימות בין CLAUDE.md ל-ADR.** אין היום כלל שקובע מי גובר. אפשר להוסיף שורה ל-"Sources of truth".
2. **הפקודות הגלובליות** (`~/.claude/commands/`, משפיעות על כל הפרויקטים) מושכות נגד הכללים החדשים:
   - `review.md`: Agent 2 בודק "docstrings", וקטגוריית Minor כוללת "documentation gaps" ו-"missing edge cases".
   - `dev.md`, שלב E: מתקן גם ממצאי Minor ("Fix every listed finding"), ולכן מחזיר הערות ובדיקות.
   - **זה המנוף הכי אפקטיבי:** לתקן רק Major, או לקבוע ש"פער ש-CLAUDE.md אומר לא למלא אינו ממצא".
   - `quality-review.md`: עקרונות SOLID O/D מתגמלים הפשטות.
3. **ממצאים שעלו אגב:**
   - שלב E ב-`dev.md` מריץ `checks.sh test` בלי נתיב, ו-`python -m ruff`. שני הדברים אסורים לפי CLAUDE.md.
   - `.claude/project-params.md` מיושן: מציין "ADRs 0001-0005" ו-Mongo "planned", מזכיר שני פרויקטי Vitest במקום ארבעה, ומריץ בדיקות על תיקייה.
4. **החלפת `webPushSender.ts`** בספריית `web-push`: משימת `/work` נפרדת, כולל תיקון של ADR-0013. כלל לבד לא יסיר את הקוד הקיים.

## מנוף דטרמיניסטי לעתיד (אופציונלי)
כלל ESLint `max-lines` (בערך 500, עם `skipComments: false`). לא דורש תלות חדשה.
