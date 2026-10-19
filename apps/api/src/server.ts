// Local entry point: `npm run dev:api`. Env vars come from apps/api/.env (see .env.example).
import { app } from './app.ts';

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
});
