'use strict';
/* Authentication, session and setup behaviour (real database). */
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const { fresh, PW } = H;

test.after(async () => { await H.stopServer(); });

test('A1 passwords are stored as salted scrypt hashes, never plain text', async () => {
  const x = await fresh(), { db } = x;
  const u = (await db.query("select pw_salt,pw_hash from users where username='cashier'")).rows[0];
  assert.ok(u.pw_hash.length >= 64 && !u.pw_hash.includes(PW) && u.pw_salt.length >= 16);
  const salts = (await db.query('select count(distinct pw_salt)::int c, count(*)::int n from users')).rows[0]; assert.equal(salts.c, salts.n);
  const ex = await x.C.admin.get('/api/admin/export'); assert.ok(!JSON.stringify(ex.data).includes(u.pw_hash), 'export never contains hashes');
  await db.end();
});

test('A2 login throttling locks an account after 5 failures, and the right password cannot bypass it', async () => {
  const x = await fresh(), { db } = x, c = H.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.login('cashier', 'wrong-pass-' + i)).status, 401);
  assert.equal((await c.login('cashier', PW)).status, 429);
  assert.equal((await H.client().login('manager', PW)).status, 200, 'other accounts unaffected');
  const msg = await H.client().login('nobody', 'x'); assert.equal(msg.status, 401); assert.equal(msg.error, (await H.client().login('manager', 'bad')).error, 'same message for unknown user and wrong password');
  await db.end();
});

test('A3 per-device throttling stops password spraying across many usernames', async () => {
  const x = await fresh(), { db } = x, c = H.client('203.0.113.9'); let last;
  for (let i = 0; i < 32; i++) last = await c.login('user' + i, 'whatever-' + i);
  assert.equal(last.status, 429); assert.equal((await H.client('198.51.100.7').login('manager', PW)).status, 200);
  await db.end();
});

test('A4 logout, password change, disabling and expiry all invalidate sessions server-side', async () => {
  const x = await fresh(), { C, db } = x;
  const saved = C.cashier.cookie; await C.cashier.post('/api/logout');
  const replay = H.client(); replay.cookie = saved; assert.equal((await replay.get('/api/state')).status, 401, 'old cookie is dead after logout');
  // password change signs out other devices but keeps this one
  const d1 = H.client(), d2 = H.client(); await d1.login('waiter', PW); await d2.login('waiter', PW);
  assert.equal((await d1.post('/api/me/password', { current: PW, password: 'Brand-new-pass-7' })).status, 200);
  assert.equal((await d1.get('/api/state')).status, 200); assert.equal((await d2.get('/api/state')).status, 401);
  assert.equal((await H.client().login('waiter', PW)).status, 401); assert.equal((await H.client().login('waiter', 'Brand-new-pass-7')).status, 200);
  assert.equal((await d1.post('/api/me/password', { current: 'nope-nope-1', password: 'Another-pass-8' })).status, 403);
  // disabling a user kills live sessions
  assert.equal((await C.admin.post('/api/user/toggle', { id: x.U.receptionist })).status, 200); assert.equal((await C.receptionist.get('/api/state')).status, 401);
  assert.equal((await H.client().login('receptionist', PW)).status, 401);
  // expired session
  await db.query("update sessions set expires_at='2000-01-01T00:00:00.000Z' where user_id=$1", [x.U.storekeeper]); assert.equal((await C.storekeeper.get('/api/state')).status, 401);
  // cookie flags
  const l = await H.client().login('manager', PW); const sc = l.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  // session tokens are stored hashed
  const row = (await db.query('select token_hash from sessions limit 1')).rows[0]; assert.equal(row.token_hash.length, 64);
  await db.end();
});

test('A5 password policy: weak passwords are refused for new users and resets', async () => {
  const x = await fresh(), { C, db } = x;
  for (const pw of ['short', '12345678', 'password', 'aaaaaaaa', 'newuser1']) assert.equal((await C.admin.post('/api/user/create', { username: 'newuser1', name: 'N', role: 'cashier', password: pw })).status, 400, pw);
  assert.equal((await C.admin.post('/api/user/create', { username: 'bad name!', name: 'N', role: 'cashier', password: PW })).status, 400);
  assert.equal((await C.admin.post('/api/user/create', { username: 'newuser1', name: 'N', role: 'superuser', password: PW })).status, 400);
  assert.equal((await C.admin.post('/api/user/create', { username: 'Cashier', name: 'Dup', role: 'cashier', password: PW })).status, 409, 'usernames are unique case-insensitively');
  await db.end();
});

test('A6 first-run setup works once only, and can be locked with SETUP_KEY', async () => {
  await H.resetDb(); await H.restartServer();
  const c = H.client();
  assert.equal((await c.get('/api/status')).data.needsSetup, true);
  process.env.SETUP_KEY = 'letmein-123456';
  try {
    assert.equal((await c.post('/api/setup', { username: 'owner', name: 'O', password: PW })).status, 403, 'missing key refused');
    assert.equal((await c.post('/api/setup', { username: 'owner', name: 'O', password: PW, setupKey: 'wrong' })).status, 403);
    assert.equal((await c.get('/api/status')).data.needsSetup, true);
    assert.equal((await c.post('/api/setup', { username: 'owner', name: 'O', password: PW, setupKey: 'letmein-123456' })).status, 200);
  } finally { delete process.env.SETUP_KEY; }
  assert.equal((await c.get('/api/status')).data.needsSetup, false);
  assert.equal((await H.client().post('/api/setup', { username: 'second', name: 'S', password: PW })).status, 403);
  const r = await Promise.all([1, 2, 3].map(i => H.client().post('/api/setup', { username: 'x' + i, name: 'S', password: PW })));
  assert.ok(r.every(z => z.status === 403));
});

test('A7 security headers and database access lockdown', async () => {
  const x = await fresh(), { db } = x;
  const tables = (await db.query("select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows;
  assert.ok(tables.length >= 16); for (const t of tables) assert.equal(t.relrowsecurity, true, t.relname + ' must have RLS enabled');
  for (const t of tables) for (const role of ['anon', 'authenticated']) for (const priv of ['select', 'insert', 'update', 'delete']) assert.equal((await db.query('select has_table_privilege($1,$2,$3) ok', [role, 'public.' + t.relname, priv])).rows[0].ok, false, `${role} ${priv} ${t.relname}`);
  const pol = (await db.query("select count(*)::int c from pg_policies where schemaname='public'")).rows[0].c; assert.equal(pol, 0, 'no policies: the public REST API can read nothing');
  const r = await fetch(H.url() + '/api/state', { headers: { 'x-forwarded-for': '1.2.3.4' } }); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const vj = JSON.parse(require('fs').readFileSync(require('path').join(H.APP, 'vercel.json'), 'utf8')); const hs = Object.fromEntries(vj.headers[0].headers.map(h => [h.key.toLowerCase(), h.value]));
  assert.match(hs['content-security-policy'], /frame-ancestors 'none'/); assert.ok(hs['strict-transport-security'], 'HSTS header configured');
  // no secrets in the browser bundle
  const front = require('fs').readFileSync(require('path').join(H.APP, 'public', 'app.js'), 'utf8') + require('fs').readFileSync(require('path').join(H.APP, 'public', 'index.html'), 'utf8');
  assert.ok(!/DATABASE_URL|service_role|postgres:\/\/|eyJhbGci/.test(front));
  await db.end();
});
