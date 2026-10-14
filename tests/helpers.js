'use strict';
/* Test harness: boots the REAL api handler in-process against a REAL Postgres database (no mocks).
   Set APP_DIR to point the suite at another copy of the project (used to run the suite against the original upload). */
const http = require('http'), fs = require('fs'), path = require('path');
const APP = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.join(__dirname, '..');
const pg = require(require.resolve('pg', { paths: [APP] }));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/pos_test';
process.env.DATABASE_SSL = 'off'; process.env.COOKIE_SECURE = '0'; process.env.NODE_ENV = 'test'; process.env.TZ_OFFSET_HOURS = '3';
const ADMIN_URL = process.env.TEST_ADMIN_URL || 'postgres://postgres@localhost:54329/postgres';

/* count every statement sent to Postgres (used by the performance test) */
const counter = { on: false, n: 0 };
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...a) { if (counter.on) counter.n++; return origQuery.apply(this, a); };

const migrations = () => fs.readdirSync(path.join(APP, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort();
async function dbClient(url = process.env.DATABASE_URL) { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }

async function resetDb(upTo) {
  const c = await dbClient();
  await c.query('drop schema public cascade; create schema public; grant all on schema public to public;');
  await c.query("do $$ begin begin create role anon; exception when duplicate_object then null; end; begin create role authenticated; exception when duplicate_object then null; end; end $$");
  for (const f of migrations()) { if (upTo && f > upTo) break; await c.query(fs.readFileSync(path.join(APP, 'supabase', 'migrations', f), 'utf8')); }
  await c.end();
}

let server, base, handler;
function loadApp() { delete require.cache[require.resolve(path.join(APP, 'api', 'index.js'))]; handler = require(path.join(APP, 'api', 'index.js')); }
async function startServer() {
  loadApp();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); u.searchParams.set('__p', u.pathname.replace(/^\/api\//, '')); req.url = '/api/index' + u.search; return handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
}
async function stopServer() { if (server) await new Promise(r => server.close(r)); server = null; }
async function restartServer() { await stopServer(); await startServer(); }

let ipn = 0;
function client(fakeIp) {
  let cookie = ''; const ip = fakeIp || '10.0.' + (Math.floor(++ipn / 250)) + '.' + (ipn % 250);
  const c = {
    ip,
    async call(method, p, body, extra = {}) {
      const headers = { 'Content-Type': 'application/json', 'X-POS': '1', 'x-forwarded-for': ip, ...extra };
      if (cookie) headers.cookie = cookie;
      const r = await fetch(base + p, { method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) { const m = /sid=([^;]*)/.exec(sc); cookie = m && m[1] ? 'sid=' + m[1] : ''; }
      let j = {}; try { j = await r.json(); } catch (e) {}
      return { status: r.status, ok: !!j.ok, data: j.data, error: j.error, headers: r.headers };
    },
    post: (p, b, e) => c.call('POST', p, b, e), get: (p, e) => c.call('GET', p, undefined, e),
    async login(u, pw) { return c.post('/api/login', { username: u, password: pw }); },
    get cookie() { return cookie; }, set cookie(v) { cookie = v; }
  };
  return c;
}

const PW = 'Str0ng-pass-1';
const ROLES = ['manager', 'cashier', 'bartender', 'waiter', 'kitchen', 'receptionist', 'storekeeper'];
/* fresh database + admin + one user per role + a small catalogue */
async function fresh() {
  await resetDb(); await restartServer();
  const A = client(); let r = await A.post('/api/setup', { username: 'owner', name: 'The Owner', password: PW }); if (r.status !== 200) throw new Error('setup failed ' + JSON.stringify(r));
  await A.login('owner', PW);
  const C = { admin: A }, U = {};
  const st0 = (await A.get('/api/state')).data; U.admin = st0.me.id;
  for (const role of ROLES) {
    r = await A.post('/api/user/create', { username: role, name: role[0].toUpperCase() + role.slice(1) + ' Person', role, password: PW }); if (r.status !== 200) throw new Error('create ' + role + JSON.stringify(r));
    U[role] = r.data.id; C[role] = client(); await C[role].login(role, PW);
  }
  const P = {}, mk = async (key, b) => { const x = await A.post('/api/product/create', b); if (x.status !== 200) throw new Error('product ' + key + JSON.stringify(x)); P[key] = x.data.id; };
  await mk('tusker', { name: 'Tusker', cat: 'Beer', dept: 'bar', price: 300, cost: 0, reorder: 5 });
  await mk('cola', { name: 'Cola', cat: 'Soft', dept: 'bar', price: 100, cost: 0, reorder: 5 });
  await mk('beef', { name: 'Beef (kg)', cat: 'Ingredient', dept: 'store', price: 0, cost: 0, reorder: 2 });
  await mk('nyama', { name: 'Nyama Choma', cat: 'Food', dept: 'rest', price: 900, cost: 0, reorder: 0 });
  await mk('tea', { name: 'Tea', cat: 'Drinks', dept: 'rest', price: 80, cost: 0, reorder: 0 });
  await A.post('/api/stock/receive', { pid: P.tusker, qty: 20, cost: 200, idem: 'seed-1' });
  await A.post('/api/stock/receive', { pid: P.cola, qty: 20, cost: 50, idem: 'seed-2' });
  await A.post('/api/stock/receive', { pid: P.beef, qty: 10, cost: 900, idem: 'seed-3' });
  await A.post('/api/stock/receive', { pid: P.tea, qty: 100, cost: 10, idem: 'seed-4' });
  r = await A.post('/api/product/recipe', { id: P.nyama, ingredients: [{ pid: P.beef, qty: 0.5 }] }); if (r.status !== 200) throw new Error('recipe ' + JSON.stringify(r));
  await A.post('/api/room/create', { no: '1', type: 'Single', rate: 2500 }); await A.post('/api/room/create', { no: '2', type: 'Double', rate: 3500 });
  const db = await dbClient();
  return { C, U, P, db, A };
}
let tok = 0; const T = p => (p || 't') + '-' + Date.now() + '-' + (++tok);
const dayPlus = n => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const stockOf = async (db, pid) => Number((await db.query('select stock from products where id=$1', [pid])).rows[0].stock);
const sellBar = (c, ctx, items, method = 'Cash', extra = {}) => c.post('/api/sale', { token: T(), dept: 'bar', items, staffId: ctx.U.bartender, method, ...extra });
const sellRest = (c, ctx, items, method = 'Cash', extra = {}) => c.post('/api/sale', { token: T(), dept: 'rest', items, staffId: ctx.U.waiter, method, table: 'T1', ...extra });

module.exports = { url: () => base, APP, counter, resetDb, startServer, stopServer, restartServer, client, fresh, dbClient, T, dayPlus, stockOf, sellBar, sellRest, PW, ROLES, migrations, ADMIN_URL };
