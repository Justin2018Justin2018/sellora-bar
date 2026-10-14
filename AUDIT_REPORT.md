# Audit report — Savanna Lodge POS (uploaded as "sellora-bar-main")

Method: read all ~1,000 lines, ran the original against a real PostgreSQL 16 with a 22-test suite, fixed, re-ran. Everything below was reproduced by a failing test on the original code first.

Note: the upload is branded **Savanna Lodge POS** (Node 22, one Vercel function, Supabase Postgres, static front end). The expression `b.status !== 'out' || true` does not exist in it; the only `status !== 'out'`-style code (api/index.js:302, deposits held) is correct.

## Confirmed defects (original → fix)
| # | Sev | Defect | Fix | Test |
|---|---|---|---|---|
| D1 | High (money) | A refund approved by a manager was booked to the *manager*, so the cashier's shift expected cash stayed too high (KSh 600 false shortage in test) | refund booked to the till operator; approver still audited | D1 |
| D4 | High (money) | Importing the same legacy file twice duplicated every expense | expenses de-duplicated, input validated | D4 |
| D5 | High (stock/money) | Retried "receive stock" / expense requests were applied twice (stock 50 instead of 30) | idempotency key (migration adds `idem` columns) | D5 |
| D7 | Medium | Guest credit (deposit above bill, reversed room-posted sale) could never be paid back | `POST /api/room/refund` (approve permission) | D7 |
| D6 | Medium | "Wastage" could *increase* stock | refused | D6 |
| D9 | Medium | Double-booking prevented only in app code | DB trigger (tested by direct SQL) | D9 |
| D2 | Medium | Any role could list every login name | usernames admin-only | D2 |
| D3 | Medium | Raw database error text (constraint/table names) sent to the browser; bad recipes (duplicate/non-ingredient) gave 500 | errors translated; recipe validation | D3 |
| D8 | Medium | CSV export silently limited to latest 500 sales, so it could disagree with the report | server-side full-range export, formula-injection guard | D8 |
| D10 | Medium (perf) | `/api/state` and report ran queries per open bill/booking | set-based; ≤ 30 statements | D10 |
| D14 | Low | Same sale token with a different basket silently returned the old sale | 409 | D14 |
| D11 | Low | Test fault hook active in production | disabled when NODE_ENV=production | D11 |
| — | Low | Receipt printed floats (e.g. 37.019999…) | exact cents rounding | smoke test |
| — | Low | Front-end timezone hard-coded; no HSTS; dev server wrong MIME; dark-mode button contrast failed WCAG | server tz; HSTS; fixed; contrast fixed | smoke, axe |
| — | Opt-in | First-run owner account claimable by anyone; DB TLS not verified | `SETUP_KEY`; `DATABASE_SSL_CA` | A6 |
| D12 | Feature gap | No way to retire/restore an item | `POST /api/product/archive` | D12 |

Found sound (tests pass on the original): password hashing (scrypt), login throttling, session expiry/logout/invalidations, role matrix, CSRF guard, append-only ledger triggers, RLS lock-down, atomic sales, oversell protection, duplicate-sale protection, concurrent booking, checkout debt approval.

## Keg / litre sales (second request)
Implemented in the existing code: migration `20261014010000_keg.sql`; `POST /api/keg/setup`, `POST /api/keg/receive`, `GET /api/report/kegs`; admin-only price choices (`price_opts`); Stock/Reports UI. Details in BILLING_RULES.md. Verified: 2 glasses + 1 jug = exactly 2.5 L (UI and API); 100 glasses = exactly 50 L, KSh 7,000, cost KSh 5,358, gross profit KSh 1,642; jug at 210 and 250 deduct the same 1.5 L; refused when short; void returns litres once; duplicates/concurrency safe; restart persistence; reconciliation received − sold + adjustments = remaining. A deliberately injected 1 % over-deduction made 9 of 11 keg tests fail.

## Evidence (actual runs)
- `npm test`: 48 integration/smoke tests, 48 pass (original upload: 14 of the 35 pre-keg tests failed — A6, A7, D1–D12; D10 measured 37 statements for the state screen on the original).
- Browser (Chromium, 1366/820/390 px): 46 checks + 13 keg-flow checks, 0 failures, no console/CSP errors, no horizontal scroll on any tab.
- axe-core WCAG 2.1 A/AA on all 9 screens, light and dark, desktop and phone: 0 violations (20 before the contrast fix).
- `npm audit`: 0 vulnerabilities (single dependency `pg`).
- Migration/backup: dump → restore → re-run all migrations on a copy: row counts and hashes unchanged; rollback + re-apply keeps all records.

## Not verified / known limitations
- Not run against real Supabase/Vercel; RLS tested on vanilla Postgres with `anon`/`authenticated` roles (no grants, no policies), not through Supabase's REST endpoint.
- No load test. All writes share one advisory lock (correct, but a throughput ceiling).
- CSP still needs `'unsafe-inline'` (inline onclick handlers). A user can lock another account by failing logins 5×. IP throttling trusts `X-Forwarded-For`.
- M-Pesa/Card are labels only: no gateway integration, no statement reconciliation. No tax/discount/service-charge features exist, so none were tested.
- Policy kept as-is: early checkout is charged the full booked nights; room revenue is recognised at check-out.
- Keg revenue per keg is attributed through *current* recipes; if a serving's litres are edited later, old periods are re-attributed. Cost per litre is rounded to whole cents.
- State screen caps at the latest 500 sales; accessibility checked by automation only (no screen-reader test).

## Scores (earned, not aspirational)
Security 8 · Financial accuracy 8.5 · Database integrity 8.5 · Inventory accuracy 8.5 · Booking reliability 8.5 · UX 7.5 · Performance 7 (measured by statement count only) · Maintainability 7 (single 400-line file backend) · Test coverage 8 · Production readiness 7.5 (until a staging run on Supabase/Vercel). Not a 10/10; the gaps are listed above.

## Deploy
Run the three migrations in order in Supabase; set `DATABASE_URL`, `TZ_OFFSET_HOURS`, `SETUP_KEY` in Vercel; deploy; create the owner immediately. Rollback: redeploy the previous version, then run the matching file in `supabase/rollbacks/` only if needed.
