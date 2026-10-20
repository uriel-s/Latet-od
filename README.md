# לתת עוד: אפליקציית איסוף בקבוקים

"הבקבוקים שלכם, התפילין שלהם!"

לקוחות בבית שמש מזמינים איסוף בקבוקים בטופס קצר, יואל (האוסף) מתכנן סבב לפי חצי עיר, הלקוחות מאשרים בקישור
מ-WhatsApp, ויואל נוסע לפי רשימה מסודרת. הכסף מממן תפילין לנערי בר מצווה ולחיילים.

## הרצה מקומית

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
