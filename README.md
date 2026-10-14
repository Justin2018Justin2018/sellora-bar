# Savanna Lodge POS: Vercel + Supabase

```
api/index.js                              the whole backend (one Vercel serverless function)
supabase/migrations/…_init.sql            database schema (Postgres)
public/index.html + public/app.js        front end (static files; talks to /api, stores nothing in the browser)
tests/                                    `npm test`: smoke test of every screen + real-Postgres integration tests (needs TEST_DATABASE_URL, default postgres://postgres@localhost:54329/pos_test)
vercel.json / package.json                routing, security headers, dependency (pg)
BILLING_RULES.md                          the accounting rules the backend enforces
```

## Deploy (about 15 minutes)
1. **Supabase**: create a project (or pick an empty one dedicated to this POS: do not share it with another app).
   SQL Editor > run every file in `supabase/migrations/` in name order (`..._init.sql`, `..._hardening.sql`, `..._keg.sql`). All are safe to re-run.
   Rollback scripts are in `supabase/rollbacks/` (redeploy the previous API first).
2. **Connection string**: Project Settings > Database > Connection string > *Transaction pooler* (port 6543). Replace `[YOUR-PASSWORD]`.
3. **GitHub**: create a **private** repo, then from this folder:
   `git init && git add . && git commit -m "Savanna POS" && git branch -M main && git remote add origin <repo-url> && git push -u origin main`
4. **Vercel**: Add New > Project > import the repo > Environment Variables: `DATABASE_URL` (from step 2), `TZ_OFFSET_HOURS=3` > Deploy.
5. Open the site **immediately** and create the owner account (the setup screen only works once, until a user exists). Use a strong password.
6. Sign in > **Users** tab > *Load starter menu & rooms* (or import the old app's data), then **Stock** to set prices and receive opening stock.

## Notes
- The database connection string only ever lives in Vercel's environment variables, never in `public/`.
- All tables have Row Level Security on with no policies, so Supabase's public REST API cannot read them.
- File backups are gone (serverless has no disk). Use Supabase's backups (paid plans) and `GET /api/admin/export` (admin) for a JSON copy.
- Local run: `npm i`, set `DATABASE_URL` and `COOKIE_SECURE=0`, then `node dev.js`.

## Added in the audit (see AUDIT_REPORT.md)
- Set `SETUP_KEY` on a new deploy so nobody else can claim the first-run owner account. Optionally set `DATABASE_SSL_CA` to verify the database certificate.
- **Keg sales**: Stock > *Set up a keg* (defaults: Tusker 50 L, KSh 5,358, glass 500 ml KSh 70, jug 1,500 ml KSh 210/250), then *Receive keg*. Reports shows the litres report.
- Stock receipts, stock counts and expenses now carry an idempotency key (the browser adds it); API clients must send `idem`.
- Backup: Supabase backups + `GET /api/admin/export` (admin) or `pg_dump`. Restore: `psql -f dump.sql` into an empty database, then re-run the migrations (tested in tests/scenarios.test.js, scenario 15).
