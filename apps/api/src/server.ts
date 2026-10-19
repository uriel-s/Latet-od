// Local entry point: `npm run dev:api` (and plain Node hosting, ADR-0002). Env vars come from
// apps/api/.env (see .env.example). It builds the real dependencies once for the process and
// listens; the Vercel function entry (section 10) will build the same deps without listen().
import { createApp } from './app.ts';
import { createMongoDeps } from './db/mongoDeps.ts';

const uri = process.env.MONGODB_URI;
if (!uri) {
  // Fail fast: never fall back to in-memory storage, where every order would be lost on restart.
  console.error(
    'MONGODB_URI is not set: copy apps/api/.env.example to apps/api/.env and fill it in.',
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);

createApp(createMongoDeps(uri)).listen(port, (error) => {
  if (error) {
    // E.g. the port is taken. Startup errors hold no request data.
    console.error(`api could not listen on port ${port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`api listening on http://localhost:${port}`);
});
