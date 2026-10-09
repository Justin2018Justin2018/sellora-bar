# Savanna Lodge POS: Vercel + Supabase

```
api/index.js                              the whole backend (one Vercel serverless function)
supabase/migrations/…_init.sql            database schema (Postgres)
public/index.html + public/app.js        front end (static files; talks to /api, stores nothing in the browser)
tests/frontend-smoke.js                   renders every screen for every role against mock data:  node tests/frontend-smoke.js
vercel.json / package.json                routing, security headers, dependency (pg)
BILLING_RULES.md                          the accounting rules the backend enforces
```

## Deploy (about 15 minutes)
1. **Supabase**: create a project (or pick an empty one dedicated to this POS: do not share it with another app).
   SQL Editor > paste `supabase/migrations/20261009000000_init.sql` > Run.
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
