'use strict';
/* Savanna Lodge POS - backend for Vercel (serverless) + Supabase Postgres.
   Ported from the SQLite/Node server: same rules, same API, same JSON shapes.
   All authentication, authorisation, validation, money maths and stock/booking rules live HERE.
   The browser only displays data and sends commands. Money = integer cents, quantities = double precision. */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');
types.setTypeParser(20, Number);   // bigint  (COUNT, cents) -> JS number
types.setTypeParser(1700, Number); // numeric (SUM of bigint) -> JS number

const SESSION_H = Number(process.env.SESSION_HOURS || 10), IDLE_MIN = Number(process.env.IDLE_MINUTES || 60);
const TZ = Number(process.env.TZ_OFFSET_HOURS || 3), TZS = (TZ >= 0 ? '+' : '') + TZ + ' hours';

/* ---------------------------------------------------------------- helpers */
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const now = () => new Date().toISOString(), rid = p => p + '-' + crypto.randomBytes(6).toString('hex');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const cents = x => { const n = Number(x); if (x === '' || x == null || !Number.isFinite(n) || n < 0 || n > 1e9) bad('Invalid amount'); return Math.round(n * 100); };
const m = c => (c || 0) / 100;
const num = (x, min, max, label) => { const n = Number(x); if (x === '' || x == null || !Number.isFinite(n) || n < min || n > max) bad(label + ' is invalid'); return n; };
const str = (x, max, label, req = true) => { const s = String(x == null ? '' : x).trim(); if (req && !s) bad(label + ' is required'); if (s.length > max) bad(label + ' is too long'); return s; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const today = () => new Date(Date.now() + TZ * 3600e3).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const METHODS = ['Cash', 'M-Pesa', 'Card'];

/* ---------------------------------------------------------------- database (Supabase Postgres via the pooler) */
let pool;
const getPool = () => pool || (pool = new Pool({
  connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 3), idleTimeoutMillis: 10000,
  ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false }
}));
const als = new AsyncLocalStorage();               // per-request context: { ip, client }
const ip = () => (als.getStore() || {}).ip || '';
const toPg = sql => { let n = 0; return sql.replace(/\?/g, () => '$' + (++n)); };   // keep the original ? placeholders
const exec = (sql, a) => { const s = als.getStore(); return ((s && s.client) || getPool()).query(toPg(sql), a); };
const q = async (sql, ...a) => (await exec(sql, a)).rows;
const q1 = async (sql, ...a) => (await exec(sql, a)).rows[0];
const run = async (sql, ...a) => exec(sql, a);
/* One writer at a time (same guarantee SQLite's BEGIN IMMEDIATE gave): a transaction-scoped advisory lock. */
async function tx(fn) {
  const s = als.getStore(); if (s.client) return fn();
  const c = await getPool().connect();
  try { await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(7701)'); s.client = c; const r = await fn(); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { s.client = null; c.release(); }
}

/* ---------------------------------------------------------------- auth */
const PERMS = {
  admin: ['*'],
  manager: ['sell', 'pay', 'void', 'rooms', 'stock', 'price', 'finance', 'reports', 'kitchen', 'approve', 'shift'],
  cashier: ['sell', 'pay', 'shift'], bartender: ['sell', 'shift'], waiter: ['sell', 'kitchen'], kitchen: ['kitchen'],
  receptionist: ['rooms', 'pay', 'sell', 'shift'], storekeeper: ['stock']
};
const can = (u, p) => { const r = PERMS[u.role] || []; return r.includes('*') || r.includes(p); };
async function audit(u, action, detail) { (await run('INSERT INTO audit_log(ts,user_id,user_name,action,detail,ip) VALUES(?,?,?,?,?,?)', now(), u ? u.id : null, u ? u.name : '-', action, String(detail || '').slice(0, 500), ip())); }
async function need(u, p) { if (!can(u, p)) { (await audit(u, 'DENIED', p)); throw new HttpError(403, 'Not permitted: your role cannot ' + p); } }
const SCRYPT = { N: 16384, r: 8, p: 1 };
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64, SCRYPT).toString('hex') });
const checkPw = (pw, salt, hash) => { const h = crypto.scryptSync(String(pw), salt, 64, SCRYPT), e = Buffer.from(hash, 'hex'); return h.length === e.length && crypto.timingSafeEqual(h, e); };
function policy(pw, username) { pw = String(pw || ''); if (pw.length < 8) bad('Password must be at least 8 characters.'); if (pw.toLowerCase() === String(username || '').toLowerCase() || /^(.)\1+$/.test(pw) || ['12345678', 'password', 'password1', 'qwertyui'].includes(pw.toLowerCase())) bad('That password is too easy to guess.'); }
async function throttle(key, max, label) {
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  if ((await q1('SELECT COUNT(*) c FROM login_attempts WHERE k=? AND ts>?', key, since)).c >= max) throw new HttpError(429, 'Too many failed attempts for ' + label + '. Try again in 15 minutes.');
}
async function failed(key) { return (await run('INSERT INTO login_attempts(k,ts) VALUES(?,?)', key, now())); }
async function login(_u, b, req, res) {
  const un = str(b.username, 60, 'Username'), pw = String(b.password || '');
  (await throttle('u:' + un.toLowerCase(), 5, 'this account')); (await throttle('ip:' + ip(), 30, 'this device'));
  const u = (await q1('SELECT * FROM users WHERE lower(username)=lower(?)', un));
  const ok = u ? checkPw(pw, u.pw_salt, u.pw_hash) : (crypto.scryptSync(pw, 'x'.repeat(32), 64, SCRYPT), false);
  if (!ok || !u.active) { (await failed('u:' + un.toLowerCase())); (await failed('ip:' + ip())); (await audit(u || null, 'LOGIN FAILED', un)); throw new HttpError(401, 'Wrong username or password.'); }
  (await run('DELETE FROM login_attempts WHERE k=?', 'u:' + un.toLowerCase()));
  const t = crypto.randomBytes(32).toString('hex'), exp = new Date(Date.now() + SESSION_H * 3600e3).toISOString();
  (await run('INSERT INTO sessions VALUES(?,?,?,?,?)', sha(t), u.id, now(), now(), exp));
  (await audit(u, 'login', '')); res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_H * 3600}${process.env.COOKIE_SECURE === '0' ? '' : '; Secure'}`);
  return { id: u.id, name: u.name, role: u.role };
}
async function sessionUser(req) {
  const c = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!c) return null;
  const th = sha(c[1]), s = (await q1('SELECT s.*,u.username,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?', th));
  if (!s) return null;
  if (s.expires_at < now() || !s.active || Date.now() - Date.parse(s.last_seen) > IDLE_MIN * 60e3) { (await run('DELETE FROM sessions WHERE token_hash=?', th)); return null; }
  if (Date.now() - Date.parse(s.last_seen) > 30e3) (await run('UPDATE sessions SET last_seen=? WHERE token_hash=?', now(), th));
  return { id: s.user_id, name: s.name, role: s.role, username: s.username, th };
}
async function verifyPassword(u, pw) { // re-authentication for sensitive actions, rate limited
  (await throttle('pw:' + u.id, 5, 'password confirmation')); const row = (await q1('SELECT * FROM users WHERE id=?', u.id));
  if (!checkPw(String(pw || ''), row.pw_salt, row.pw_hash)) { (await failed('pw:' + u.id)); (await audit(u, 'PASSWORD CONFIRM FAILED', '')); throw new HttpError(403, 'Wrong password.'); }
}
async function approver(a, perm) { // second person approves a sensitive action with their own credentials
  if (!a || !a.username) bad('Manager approval required.', 403);
  (await throttle('u:' + String(a.username).toLowerCase(), 5, 'approver')); const r = (await q1('SELECT * FROM users WHERE lower(username)=lower(?) AND active=1', String(a.username)));
  if (!r || !checkPw(String(a.password || ''), r.pw_salt, r.pw_hash)) { (await failed('u:' + String(a.username).toLowerCase())); throw new HttpError(403, 'Approval refused: wrong approver credentials.'); }
  const ap = { id: r.id, name: r.name, role: r.role }; if (!can(ap, perm)) throw new HttpError(403, 'That user is not allowed to approve this.'); return ap;
}

/* ---------------------------------------------------------------- stock + money primitives */
async function prod(id) { return (await q1('SELECT * FROM products WHERE id=?', id)); }
async function expand(items) { // menu items with a recipe consume their ingredients instead of themselves
  const mp = new Map();
  for (const i of items) { const rec = (await q('SELECT ingredient_id,qty FROM recipes WHERE product_id=?', i.pid));
    if (rec.length) rec.forEach(r => mp.set(r.ingredient_id, (mp.get(r.ingredient_id) || 0) + r.qty * i.qty)); else mp.set(i.pid, (mp.get(i.pid) || 0) + i.qty); }
  return mp;
}
async function unitCost(pid) { const rec = (await q('SELECT r.qty,p.cost_c FROM recipes r JOIN products p ON p.id=r.ingredient_id WHERE r.product_id=?', pid)); return rec.length ? Math.round(rec.reduce((a, r) => a + r.qty * r.cost_c, 0)) : (await prod(pid)).cost_c; }
async function moveStock(map, ref, reason, sign, u) {
  for (const [pid, qty] of map) {
    const p = (await prod(pid)), nq = Math.round((p.stock + sign * qty) * 1e6) / 1e6;
    if (nq < -1e-9) bad('Not enough ' + p.name + ' (have ' + p.stock + ', need ' + qty + ')', 409);
    (await run('UPDATE products SET stock=? WHERE id=?', Math.max(0, nq), pid));
    (await run('INSERT INTO stock_moves VALUES(?,?,?,?,?,?,?)', rid('m'), now(), pid, sign * qty, reason, ref, u.name));
  }
}
async function addPayment(u, refType, refId, method, amt, kind, idem) {
  (await run('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,?)', rid('p'), now(), refType, refId, method, amt, kind, u.id, u.name, idem || null));
}
async function paid(t, id) { return (await q1('SELECT COALESCE(SUM(amount_c),0) s FROM payments WHERE ref_type=? AND ref_id=?', t, id)).s; }
async function saleBalance(s) { return (s.status !== 'active' || !['open', 'credit'].includes(s.pay_mode)) ? 0 : s.total_c - (await paid('sale', s.id)); }
function nightsFor(k) { return Math.max(1, dayDiff(k.date_in, k.date_out > today() ? k.date_out : today())); }
async function folio(b) {
  const ch = (await q1('SELECT COALESCE(SUM(amount_c),0) s FROM charges WHERE booking_id=?', b.id)).s, pa = (await paid('booking', b.id)), bal = ch - pa;
  return { ch: m(ch), pa: m(pa), bal: m(bal), payStatus: ch === 0 && pa > 0 ? 'deposit' : ch === 0 ? 'none' : bal === 0 ? 'paid' : bal < 0 ? 'credit' : pa > 0 ? 'partial' : 'unpaid', _bal_c: bal };
}

/* ---------------------------------------------------------------- commands */
async function sale(u, b) {
  (await need(u, 'sell'));
  const token = str(b.token, 80, 'Request token'), dept = ['bar', 'rest'].includes(b.dept) ? b.dept : bad('Invalid department');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) bad('Add between 1 and 100 items.');
  const items = b.items.map(i => ({ pid: str(i.pid, 40, 'Item'), qty: num(i.qty, 0.001, 10000, 'Quantity') }));
  const method = ['Cash', 'M-Pesa', 'Card', 'Split', 'Room', 'Credit'].includes(b.method) ? b.method : bad('Invalid payment method');
  if (method === 'Credit') (await need(u, 'pay'));
  const later = !!b.later && dept === 'rest' && METHODS.includes(method);
  return (await tx(async () => {
    const ex = (await q1('SELECT id FROM sales WHERE token=?', token)); if (ex) return { id: ex.id, duplicate: true };
    const staff = (await q1("SELECT * FROM users WHERE id=? AND active=1 AND role<>'kitchen'", String(b.staffId || '')));
    if (!staff) bad('Please select who did this sale before recording the transaction.');
    let total = 0; const lines = [];
    for (const i of items) {
      const p = (await prod(i.pid)); if (!p || !p.active || p.dept !== dept) bad('Item not available on this menu.');
      if (p.price_c <= 0) bad(p.name + ' has no selling price yet.'); const lt = Math.round(i.qty * p.price_c); total += lt;
      lines.push({ ...i, name: p.name, price_c: p.price_c, cost_c: (await unitCost(p.id)) });
    }
    let bk = null;
    if (method === 'Room') { bk = (await q1("SELECT * FROM bookings WHERE id=? AND status='in'", String(b.bookingId || ''))); if (!bk) bad('Pick a checked-in room.'); }
    if (method === 'Credit' && !str(b.customer, 80, 'Customer name', false)) bad('Credit sales need a customer name.');
    let cash = 0, mp = 0; if (method === 'Split') { cash = cents(b.cash); mp = cents(b.mpesa); if (cash + mp !== total) bad('Split amounts must add up to ' + m(total)); }
    const id = rid('S'), kitchen = dept === 'rest' ? 'pending' : 'done', mode = method === 'Room' ? 'room' : method === 'Credit' ? 'credit' : later ? 'open' : 'paid';
    (await run('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, token, now(), dept, staff.id, staff.name, u.name, str(b.table, 20, 'Table', false), kitchen, mode, 'active', bk ? bk.id : null, str(b.customer, 80, 'Customer', false), total, null));
    (await moveStock((await expand(items)), id, 'Sale ' + dept, -1, u));
    if (process.env.POS_TEST_FAULT === 'after_stock') throw new Error('Injected fault');
    for (const l of lines) (await run('INSERT INTO sale_items(sale_id,product_id,name,qty,price_c,cost_c) VALUES(?,?,?,?,?,?)', id, l.pid, l.name, l.qty, l.price_c, l.cost_c));
    if (bk) (await run('INSERT INTO charges VALUES(?,?,?,?,?,?,?)', rid('c'), bk.id, 'sale', id, (dept === 'bar' ? 'Bar' : 'Restaurant') + ' order ' + id, total, now()));
    else if (mode === 'paid') { if (method === 'Split') { if (cash) (await addPayment(u, 'sale', id, 'Cash', cash, 'payment')); if (mp) (await addPayment(u, 'sale', id, 'M-Pesa', mp, 'payment')); } else (await addPayment(u, 'sale', id, method, total, 'payment')); }
    (await audit(u, 'sale', id + ' ' + m(total) + ' sold by ' + staff.name + (dept === 'rest' ? '' : '')));
    return { id, total: m(total) };
  }));
}
async function settle(u, b) {
  (await need(u, 'pay')); const amt = cents(b.amount), method = METHODS.includes(b.method) ? b.method : bad('Invalid payment method'), idem = str(b.idem, 80, 'Request token');
  if (amt <= 0) bad('Amount must be above zero.');
  return (await tx(async () => {
    if ((await q1('SELECT 1 x FROM payments WHERE idem=?', idem))) return { duplicate: true };
    const s = (await q1('SELECT * FROM sales WHERE id=?', String(b.saleId))); if (!s || s.status !== 'active') bad('That bill is not open.');
    const bal = (await saleBalance(s)); if (bal <= 0) bad('This bill has no balance.'); if (amt > bal) bad('Amount is more than the balance of ' + m(bal));
    (await addPayment(u, 'sale', s.id, method, amt, 'payment', idem)); if (amt === bal && s.pay_mode === 'open') (await run("UPDATE sales SET pay_mode='paid' WHERE id=?", s.id));
    (await audit(u, 'payment', s.id + ' ' + m(amt) + ' ' + method)); return { balance: m(bal - amt) };
  }));
}
async function refundAll(u, type, id, reason) { // refund every net-positive method as a NEGATIVE payment: history is never erased
  for (const r of (await q('SELECT method,SUM(amount_c) s FROM payments WHERE ref_type=? AND ref_id=? GROUP BY method', type, id)).filter(r => r.s > 0)) (await addPayment(u, type, id, r.method, -r.s, 'refund'));
}
async function voidSale(u, b) {
  const reason = str(b.reason, 200, 'Reason'); let actor = u;
  if (!can(u, 'void')) actor = (await approver(b.approver, 'void'));
  return (await tx(async () => {
    const s = (await q1('SELECT * FROM sales WHERE id=?', String(b.saleId))); if (!s || s.status !== 'active') bad('That sale is not active.');
    const prepared = s.dept === 'rest' && ['preparing', 'ready', 'served'].includes(s.kitchen_status), restock = b.restock === undefined ? !prepared : !!b.restock;
    if (restock) { const mp = new Map(); (await q('SELECT product_id,SUM(qty) q FROM stock_moves WHERE ref=? GROUP BY product_id', s.id)).forEach(r => { if (r.q < 0) mp.set(r.product_id, -r.q); }); (await moveStock(mp, s.id, 'Reversal: ' + reason, +1, actor)); }
    (await refundAll(actor, 'sale', s.id, reason));
    if (s.booking_id) (await run('INSERT INTO charges VALUES(?,?,?,?,?,?,?)', rid('c'), s.booking_id, 'reversal', s.id, 'Reversal of ' + s.id, -s.total_c, now()));
    const st = s.dept === 'rest' && !prepared ? 'cancelled' : 'void'; (await run('UPDATE sales SET status=?,void_reason=? WHERE id=?', st, reason, s.id));
    (await audit(actor, 'void', s.id + ' ' + reason + (restock ? ' (restocked)' : ' (NOT restocked: food already prepared)') + (actor.id !== u.id ? ' requested by ' + u.name : ''))); return { status: st };
  }));
}
async function kitchen(u, b) {
  (await need(u, 'kitchen')); const NEXT = { pending: 'preparing', preparing: 'ready', ready: 'served' };
  return (await tx(async () => { const s = (await q1("SELECT * FROM sales WHERE id=? AND dept='rest'", String(b.saleId))); if (!s || s.status !== 'active') bad('That order is not active.');
    if (NEXT[s.kitchen_status] !== b.status) bad('An order cannot go from ' + s.kitchen_status + ' to ' + b.status + '.'); (await run('UPDATE sales SET kitchen_status=? WHERE id=?', b.status, s.id)); (await audit(u, 'kitchen', s.id + ' -> ' + b.status)); return {}; }));
}
async function reserve(u, b) {
  (await need(u, 'rooms')); const guest = str(b.guest, 80, 'Guest name'), din = b.in, dout = b.out; if (!isDate(din) || !isDate(dout) || dout <= din) bad('Enter valid arrival and departure dates (departure after arrival).');
  return (await tx(async () => { const r = (await q1('SELECT * FROM rooms WHERE no=?', String(b.room))); if (!r) bad('Unknown room.'); if (r.status === 'maintenance') bad('Room is under maintenance.');
    if ((await q1("SELECT 1 x FROM bookings WHERE room_no=? AND status IN('reserved','in') AND date_in<? AND date_out>?", r.no, dout, din))) bad('Room ' + r.no + ' is already booked for those dates.', 409);
    const id = rid('B'); (await run("INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, r.no, guest, str(b.phone, 30, 'Phone', false), din, dout, 'reserved', u.name, now(), null, null, null)); (await audit(u, 'reserve', id + ' room ' + r.no + ' ' + guest)); return { id }; }));
}
async function checkin(u, b) {
  (await need(u, 'rooms'));
  return (await tx(async () => { const k = (await q1("SELECT * FROM bookings WHERE id=? AND status='reserved'", String(b.bookingId))); if (!k) bad('Booking not found or not reserved.'); const r = (await q1('SELECT * FROM rooms WHERE no=?', k.room_no));
    if (r.status !== 'vacant') bad('Room ' + r.no + ' is ' + r.status + ' - it cannot be checked in.', 409); if (k.date_in > today()) bad('Arrival date is ' + k.date_in + ' - too early to check in.');
    (await run("UPDATE bookings SET status='in',in_at=? WHERE id=?", now(), k.id)); (await run("UPDATE rooms SET status='occupied' WHERE no=?", r.no)); (await audit(u, 'checkin', k.id)); return {}; }));
}
async function extend(u, b) {
  (await need(u, 'rooms')); if (!isDate(b.out)) bad('Invalid date.');
  return (await tx(async () => { const k = (await q1("SELECT * FROM bookings WHERE id=? AND status IN('reserved','in')", String(b.bookingId))); if (!k || b.out <= k.date_in) bad('Cannot extend this booking.');
    if ((await q1("SELECT 1 x FROM bookings WHERE room_no=? AND id<>? AND status IN('reserved','in') AND date_in<? AND date_out>?", k.room_no, k.id, b.out, k.date_in))) bad('Room is booked by someone else on those dates.', 409);
    (await run('UPDATE bookings SET date_out=? WHERE id=?', b.out, k.id)); (await audit(u, 'extend', k.id + ' to ' + b.out)); return {}; }));
}
async function cancelBooking(u, b) {
  (await need(u, 'rooms')); const reason = str(b.reason, 200, 'Reason');
  return (await tx(async () => { const k = (await q1("SELECT * FROM bookings WHERE id=? AND status='reserved'", String(b.bookingId))); if (!k) bad('Only reserved bookings can be cancelled.');
    (await refundAll(u, 'booking', k.id, reason)); (await run("UPDATE bookings SET status='cancelled',cancel_reason=? WHERE id=?", reason, k.id)); (await audit(u, 'cancel booking', k.id + ' ' + reason + ' (deposits refunded)')); return {}; }));
}
async function checkout(u, b) {
  (await need(u, 'rooms')); const allowDebt = !!b.allowDebt; if (allowDebt) (await need(u, 'approve'));
  return (await tx(async () => { const k = (await q1("SELECT * FROM bookings WHERE id=? AND status='in'", String(b.bookingId))); if (!k) bad('Guest is not checked in.'); const r = (await q1('SELECT * FROM rooms WHERE no=?', k.room_no));
    let nights = nightsFor(k);
    if (b.nights !== undefined) { (await need(u, 'price')); nights = num(b.nights, 1, 365, 'Nights'); str(b.reason, 200, 'Reason for changing nights'); }
    if (!(await q1("SELECT 1 x FROM charges WHERE kind='room' AND ref=?", k.id))) (await run('INSERT INTO charges VALUES(?,?,?,?,?,?,?)', rid('c'), k.id, 'room', k.id, 'Accommodation ' + nights + ' night(s) @ ' + m(r.rate_c), Math.round(nights * r.rate_c), now()));
    const f = (await folio(k)); if (f._bal_c > 0 && !allowDebt) { throw new HttpError(409, 'Outstanding balance ' + m(f._bal_c) + '. Record payment before check-out.'); }
    (await run("UPDATE bookings SET status='out',out_at=? WHERE id=?", now(), k.id)); (await run("UPDATE rooms SET status='dirty' WHERE no=?", r.no)); (await audit(u, 'checkout', k.id + ' balance ' + m(f._bal_c) + (allowDebt ? ' LEFT AS DEBT (approved)' : ''))); return { balance: m(f._bal_c) }; }));
}
async function folioPay(u, b) {
  (await need(u, 'pay')); const amt = cents(b.amount), method = METHODS.includes(b.method) ? b.method : bad('Invalid payment method'), idem = str(b.idem, 80, 'Request token'); if (amt <= 0) bad('Amount must be above zero.');
  return (await tx(async () => { if ((await q1('SELECT 1 x FROM payments WHERE idem=?', idem))) return { duplicate: true }; const k = (await q1("SELECT * FROM bookings WHERE id=? AND status IN('reserved','in','out')", String(b.bookingId))); if (!k) bad('Booking not found.');
    const f = (await folio(k)); if (k.status === 'out' && amt > f._bal_c) bad('Amount is more than the balance of ' + m(f._bal_c));
    (await addPayment(u, 'booking', k.id, method, amt, 'payment', idem)); (await audit(u, 'folio payment', k.id + ' ' + m(amt) + ' ' + method)); return {}; }));
}
async function roomStatus(u, b) {
  (await need(u, 'rooms')); const ok = { dirty: ['vacant', 'maintenance'], vacant: ['maintenance'], maintenance: ['vacant'] };
  return (await tx(async () => { const r = (await q1('SELECT * FROM rooms WHERE no=?', String(b.no))); if (!r || !(ok[r.status] || []).includes(b.status)) bad('Room cannot go from ' + (r && r.status) + ' to ' + b.status + '.');
    if (b.status === 'maintenance' && (await q1("SELECT 1 x FROM bookings WHERE room_no=? AND status='in'", r.no))) bad('A guest is in that room.'); (await run('UPDATE rooms SET status=? WHERE no=?', b.status, r.no)); (await audit(u, 'room status', r.no + ' ' + r.status + '->' + b.status)); return {}; }));
}
async function receive(u, b) {
  (await need(u, 'stock')); const qty = num(b.qty, 0.001, 1e6, 'Quantity'), cost = cents(b.cost);
  return (await tx(async () => { const p = (await prod(String(b.pid))); if (!p) bad('Unknown item.'); const newCost = Math.round((p.stock * p.cost_c + qty * cost) / (p.stock + qty)); // moving-average costing
    (await run('UPDATE products SET stock=?,cost_c=? WHERE id=?', Math.round((p.stock + qty) * 1e6) / 1e6, newCost, p.id)); (await run('INSERT INTO stock_moves VALUES(?,?,?,?,?,?,?)', rid('m'), now(), p.id, qty, 'Purchase receipt @ ' + m(cost), null, u.name)); (await audit(u, 'stock in', p.name + ' +' + qty)); return {}; }));
}
async function adjust(u, b) {
  (await need(u, 'stock')); const counted = num(b.counted, 0, 1e6, 'Counted quantity'), reason = str(b.reason, 200, 'Reason');
  return (await tx(async () => { const p = (await prod(String(b.pid))); if (!p) bad('Unknown item.'); const d = Math.round((counted - p.stock) * 1e6) / 1e6; (await run('UPDATE products SET stock=? WHERE id=?', counted, p.id));
    (await run('INSERT INTO stock_moves VALUES(?,?,?,?,?,?,?)', rid('m'), now(), p.id, d, (b.wastage ? 'Wastage: ' : 'Adjustment: ') + reason, null, u.name)); (await audit(u, 'stock adj', p.name + ' ' + d + ' ' + reason)); return { delta: d }; }));
}
async function editProduct(u, b) {
  (await need(u, 'price')); const reason = str(b.reason, 200, 'Reason', false); (await verifyPassword(u, b.password));
  return (await tx(async () => { const p = (await prod(String(b.id))); if (!p) bad('Unknown item.');
    const nv = { price: cents(b.price), cost: cents(b.cost), reorder: num(b.reorder, 0, 1e6, 'Reorder level'), category: str(b.cat, 40, 'Category') }, ch = [];
    [['price', m(p.price_c), m(nv.price)], ['cost', m(p.cost_c), m(nv.cost)], ['reorder', p.reorder, nv.reorder], ['category', p.cat, nv.category]].forEach(([f, from, to]) => { if (from !== to) ch.push({ field: f, from, to }); });
    if (!ch.length) return { changed: 0 }; if (ch.some(c => c.field === 'price' || c.field === 'cost') && !reason) bad('Please give a reason for the price/cost change.');
    (await run('UPDATE products SET price_c=?,cost_c=?,reorder=?,cat=? WHERE id=?', nv.price, nv.cost, nv.reorder, nv.category, p.id));
    (await run('INSERT INTO price_log VALUES(?,?,?,?,?,?,?,?)', rid('h'), now(), u.name, u.role, p.id, p.name, JSON.stringify(ch), reason)); (await audit(u, 'item edit', p.name + ': ' + ch.map(c => c.field + ' ' + c.from + '->' + c.to).join(', ') + ' ' + reason)); return { changed: ch.length }; }));
}
async function createProduct(u, b) {
  (await need(u, 'price'));
  return (await tx(async () => { const id = rid('p'); try { (await run('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,1)', id, str(b.name, 80, 'Name'), str(b.cat, 40, 'Category'), ['bar', 'rest', 'store'].includes(b.dept) ? b.dept : bad('Invalid department'), cents(b.price || 0), cents(b.cost || 0), 0, num(b.reorder || 0, 0, 1e6, 'Reorder'))); } catch (e) { if (e.code === '23505') bad('An item with that name exists.', 409); throw e; } (await audit(u, 'item create', b.name)); return { id }; }));
}
async function setRecipe(u, b) {
  (await need(u, 'price')); const list = Array.isArray(b.ingredients) ? b.ingredients : bad('Ingredients required');
  return (await tx(async () => { const p = (await prod(String(b.id))); if (!p) bad('Unknown item.'); (await run('DELETE FROM recipes WHERE product_id=?', p.id));
    for (const i of list) { const ing = (await prod(String(i.pid))); if (!ing || ing.id === p.id) bad('Invalid ingredient.'); (await run('INSERT INTO recipes VALUES(?,?,?)', p.id, ing.id, num(i.qty, 0.0001, 1e5, 'Ingredient quantity'))); } (await audit(u, 'recipe', p.name)); return {}; }));
}
async function roomCreate(u, b) { (await need(u, 'price')); try { (await run("INSERT INTO rooms VALUES(?,?,?,'vacant')", str(b.no, 10, 'Room number'), str(b.type, 40, 'Type'), cents(b.rate))); } catch (e) { if (e.code === '23505') bad('Room exists.', 409); if (e.code === '23514') bad('Rate must be above zero.'); throw e; } (await audit(u, 'room create', b.no)); return {}; }
async function expense(u, b) { (await need(u, 'finance')); const a = cents(b.amount); if (a <= 0) bad('Amount must be above zero.'); (await run('INSERT INTO expenses VALUES(?,?,?,?,?,?)', rid('x'), now(), str(b.cat, 40, 'Category'), str(b.desc, 200, 'Description'), a, u.name)); (await audit(u, 'expense', m(a) + ' ' + b.desc)); return {}; }
async function shiftOpen(u, b) { (await need(u, 'shift')); const f = cents(b.float || 0); return (await tx(async () => { if ((await q1('SELECT 1 x FROM shifts WHERE user_id=? AND closed_at IS NULL', u.id))) bad('You already have an open shift.'); (await run('INSERT INTO shifts VALUES(?,?,?,?,?,?,?,?)', rid('sh'), u.id, u.name, now(), f, null, null, null)); (await audit(u, 'shift open', m(f))); return {}; })); }
async function shiftClose(u, b) {
  (await need(u, 'shift')); const counted = cents(b.counted);
  return (await tx(async () => { const s = (await q1('SELECT * FROM shifts WHERE user_id=? AND closed_at IS NULL', u.id)); if (!s) bad('No open shift.');
    const cash = (await q1("SELECT COALESCE(SUM(amount_c),0) s FROM payments WHERE user_id=? AND method='Cash' AND ts>=?", u.id, s.opened_at)).s, expected = s.float_c + cash;
    (await run('UPDATE shifts SET closed_at=?,expected_c=?,counted_c=? WHERE id=?', now(), expected, counted, s.id)); (await audit(u, 'shift close', 'expected ' + m(expected) + ' counted ' + m(counted) + ' variance ' + m(counted - expected))); return { expected: m(expected), counted: m(counted), variance: m(counted - expected) }; }));
}
async function userCreate(u, b) {
  (await need(u, 'users')); const un = str(b.username, 40, 'Username'); if (!/^[a-z0-9._-]{3,40}$/i.test(un)) bad('Username: 3-40 letters, numbers, . _ -'); policy(b.password, un);
  const role = Object.keys(PERMS).includes(b.role) ? b.role : bad('Invalid role'); const h = hashPw(String(b.password)), id = rid('u');
  try { (await run('INSERT INTO users VALUES(?,?,?,?,?,?,1,?)', id, un, str(b.name, 80, 'Full name'), role, h.salt, h.hash, now())); } catch (e) { if (e.code === '23505') bad('That username is taken.', 409); throw e; }
  (await audit(u, 'user create', un + ' (' + role + ')')); return { id };
}
async function userToggle(u, b) {
  (await need(u, 'users'));
  return (await tx(async () => { const t = (await q1('SELECT * FROM users WHERE id=?', String(b.id))); if (!t) bad('Unknown user.'); if (t.id === u.id) bad('You cannot disable your own account.');
    if (t.active && t.role === 'admin' && (await q1("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1")).c < 2) bad('Keep at least one active admin.');
    (await run('UPDATE users SET active=? WHERE id=?', t.active ? 0 : 1, t.id)); if (t.active) (await run('DELETE FROM sessions WHERE user_id=?', t.id)); (await audit(u, t.active ? 'user disable' : 'user enable', t.username)); return {}; }));
}
async function userReset(u, b) { (await need(u, 'users')); const t = (await q1('SELECT * FROM users WHERE id=?', String(b.id))); if (!t) bad('Unknown user.'); policy(b.password, t.username); const h = hashPw(String(b.password)); (await run('UPDATE users SET pw_salt=?,pw_hash=? WHERE id=?', h.salt, h.hash, t.id)); (await run('DELETE FROM sessions WHERE user_id=?', t.id)); (await audit(u, 'password reset', t.username)); return {}; }
async function changeOwnPassword(u, b) { (await verifyPassword(u, b.current)); const row = (await q1('SELECT username FROM users WHERE id=?', u.id)); policy(b.password, row.username); const h = hashPw(String(b.password)); (await run('UPDATE users SET pw_salt=?,pw_hash=? WHERE id=?', h.salt, h.hash, u.id)); (await run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, u.th)); (await audit(u, 'password change', '')); return {}; }

/* ---------------------------------------------------------------- the ONE financial calculation layer */
async function report(u, from, to) {
  (await need(u, 'reports')); if (!isDate(from) || !isDate(to)) bad('Invalid dates.');
  const D = c => `((${c})::timestamptz AT TIME ZONE 'UTC' + interval '${TZ} hours')::date`, R = c => `${D(c)}>=?::date AND ${D(c)}<=?::date`;
  const rev = { bar: 0, rest: 0, lodging: 0 }, cost = { bar: 0, rest: 0, lodging: 0 };
  (await q(`SELECT dept,SUM(total_c) t FROM sales WHERE status='active' AND ${R('ts')} GROUP BY dept`, from, to)).forEach(r => rev[r.dept] = r.t);
  (await q(`SELECT s.dept,SUM(ROUND(i.qty*i.cost_c)) c FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='active' AND ${R('s.ts')} GROUP BY s.dept`, from, to)).forEach(r => cost[r.dept] = r.c);
  rev.lodging = (await q1(`SELECT COALESCE(SUM(amount_c),0) t FROM charges WHERE kind='room' AND ${R('ts')}`, from, to)).t;
  const rv = rev.bar + rev.rest + rev.lodging, cs = cost.bar + cost.rest, gp = rv - cs, exp = (await q1(`SELECT COALESCE(SUM(amount_c),0) t FROM expenses WHERE ${R('ts')}`, from, to)).t;
  const pm = {}; (await q(`SELECT method,SUM(amount_c) t FROM payments WHERE ${R('ts')} GROUP BY method`, from, to)).forEach(r => pm[r.method] = m(r.t));
  const by = {}; (await q(`SELECT staff_name n,SUM(total_c) t FROM sales WHERE status='active' AND ${R('ts')} GROUP BY staff_id,staff_name`, from, to)).forEach(r => by[r.n] = m(r.t));
  const outSales = (await q1(`SELECT COALESCE(SUM(GREATEST(0,s.total_c-COALESCE((SELECT SUM(amount_c) FROM payments p WHERE p.ref_type='sale' AND p.ref_id=s.id),0))),0) t FROM sales s WHERE s.status='active' AND s.pay_mode IN('open','credit')`)).t;
  let outBook = 0, dep = 0; for (const b of (await q("SELECT * FROM bookings WHERE status IN('reserved','in','out')"))) { const f = (await folio(b)); if (b.status !== 'reserved' && f._bal_c > 0) outBook += f._bal_c; if (b.status !== 'out' && f._bal_c < 0) dep -= f._bal_c; }
  const stockVal = (await q1('SELECT COALESCE(SUM(ROUND(stock*cost_c)),0) t FROM products')).t;
  return { rev: { bar: m(rev.bar), rest: m(rev.rest), lodging: m(rev.lodging) }, cost: { bar: m(cost.bar), rest: m(cost.rest), lodging: 0 }, rv: m(rv), gp: m(gp), exp: m(exp), np: m(gp - exp), pm, bySalesperson: by,
    out: m(outSales + outBook), outSales: m(outSales), outBookings: m(outBook), deposits: m(dep), stockValue: m(stockVal) };
}

/* ---------------------------------------------------------------- state snapshot (what the browser may see) */
async function snapshot(u) {
  const money = can(u, 'finance') || can(u, 'reports') || can(u, 'price') || can(u, 'stock');
  const S = { me: { id: u.id, name: u.name, role: u.role, perms: PERMS[u.role] }, tables: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] };
  S.users = (await q('SELECT id,username,name,role,active FROM users ORDER BY name')).map(x => ({ ...x, active: !!x.active }));
  const rec = {}; (await q('SELECT * FROM recipes')).forEach(r => (rec[r.product_id] = rec[r.product_id] || []).push({ pid: r.ingredient_id, qty: r.qty }));
  S.products = (await q('SELECT * FROM products ORDER BY name')).map(p => ({ id: p.id, name: p.name, cat: p.cat, dept: p.dept, price: m(p.price_c), cost: money ? m(p.cost_c) : 0, stock: p.stock, reorder: p.reorder, active: !!p.active, recipe: rec[p.id] }));
  S.rooms = (await q('SELECT * FROM rooms ORDER BY no')).map(r => ({ no: r.no, type: r.type, rate: m(r.rate_c), status: r.status }));
  const items = {}; (await q('SELECT * FROM sale_items WHERE sale_id IN (SELECT id FROM sales ORDER BY ts DESC LIMIT 500)')).forEach(i => (items[i.sale_id] = items[i.sale_id] || []).push({ pid: i.product_id, name: i.name, qty: i.qty, price: m(i.price_c), cost: money ? m(i.cost_c) : 0 }));
  S.sales = [];
  for (const s of (await q('SELECT * FROM sales ORDER BY ts DESC LIMIT 500'))) S.sales.push({ id: s.id, ts: s.ts, dept: s.dept, items: items[s.id] || [], total: m(s.total_c), staff: s.staff_id, staffName: s.staff_name, by: s.recorded_by, table: s.table_no || '',
    status: s.status !== 'active' ? s.status : (s.dept === 'rest' ? s.kitchen_status : 'completed'), served: s.kitchen_status === 'served', pay: s.pay_mode, cust: s.customer || '', bid: s.booking_id || '', voidReason: s.void_reason || '', balance: m((await saleBalance(s))) });
  S.bookings = [];
  for (const b of (await q('SELECT * FROM bookings ORDER BY created_at'))) { const f = (await folio(b)); delete f._bal_c; if (b.status === 'in' && !(await q1("SELECT 1 x FROM charges WHERE kind='room' AND ref=?", b.id))) { const rr = (await q1('SELECT rate_c FROM rooms WHERE no=?', b.room_no)); f.est = m(nightsFor(b) * rr.rate_c); f.estNights = nightsFor(b); }
    S.bookings.push({ id: b.id, room: b.room_no, guest: b.guest, phone: b.phone, in: b.date_in, out: b.date_out, status: b.status, folio: f }); }
  S.charges = (can(u, 'rooms') || money) ? (await q('SELECT * FROM charges ORDER BY ts')).map(c => ({ id: c.id, bid: c.booking_id, type: c.kind, ref: c.ref, desc: c.descr, amount: m(c.amount_c), ts: c.ts })) : [];
  S.payments = money || can(u, 'pay') ? (await q('SELECT * FROM payments ORDER BY ts DESC LIMIT 500')).map(p => ({ id: p.id, ts: p.ts, ref: p.ref_id, refType: p.ref_type, amount: m(p.amount_c), method: p.method, kind: p.kind, user: p.user_name })) : [];
  S.moves = can(u, 'stock') || can(u, 'reports') ? (await q('SELECT * FROM stock_moves ORDER BY ts DESC LIMIT 100')).map(x => ({ id: x.id, ts: x.ts, pid: x.product_id, qty: x.qty, reason: x.reason, user: x.user_name })) : [];
  const fin = can(u, 'finance') || can(u, 'reports');
  S.expenses = fin ? (await q('SELECT * FROM expenses ORDER BY ts DESC LIMIT 200')).map(e => ({ ts: e.ts, cat: e.cat, desc: e.descr, amount: m(e.amount_c), user: e.user_name })) : [];
  S.shifts = (fin ? (await q('SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 50')) : (await q('SELECT * FROM shifts WHERE user_id=? ORDER BY opened_at DESC LIMIT 20', u.id))).map(s => ({ id: s.id, user: s.user_id, userName: s.user_name, open: s.opened_at, float: m(s.float_c), close: s.closed_at, expected: s.expected_c == null ? null : m(s.expected_c), counted: s.counted_c == null ? null : m(s.counted_c) }));
  S.priceLog = fin || can(u, 'price') ? (await q('SELECT * FROM price_log ORDER BY ts DESC LIMIT 100')).map(h => ({ ts: h.ts, user: h.user_name, item: h.item, changes: JSON.parse(h.changes), reason: h.reason })) : [];
  S.audit = fin ? (await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')).map(a => ({ ts: a.ts, user: a.user_name, action: a.action, detail: a.detail })) : [];
  return S;
}

async function importLegacy(u, S) { // one-off import of the old browser (localStorage) data. Idempotent; never overwrites.
  (await need(u, 'users')); if (!S || !Array.isArray(S.products)) bad('That is not a Savanna POS export.');
  const before = { products: S.products.length, sales: (S.sales || []).length, salesTotal: (S.sales || []).reduce((a, s) => a + Math.round(Number(s.total || 0) * 100), 0) };
  return (await tx(async () => { let np = 0, ns = 0, nsTot = 0; const pmap = {};
    for (const p of S.products) { const ex = (await q1('SELECT id FROM products WHERE lower(name)=lower(?)', p.name)); if (ex) { pmap[p.id] = ex.id; continue; } const id = rid('p'); pmap[p.id] = id; np++;
      (await run('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?)', id, p.name, p.cat || 'Other', ['bar', 'rest', 'store'].includes(p.dept) ? p.dept : 'bar', cents(p.price || 0), cents(p.cost || 0), Math.max(0, Number(p.stock) || 0), Math.max(0, Number(p.reorder) || 0), p.active === false ? 0 : 1));
      if (Number(p.stock) > 0) (await run('INSERT INTO stock_moves VALUES(?,?,?,?,?,?,?)', rid('m'), now(), id, Number(p.stock), 'Migration: opening balance', null, u.name)); }
    for (const p of S.products || []) for (const r of p.recipe || []) { if (pmap[p.id] && pmap[r.pid]) (await run('INSERT INTO recipes VALUES(?,?,?) ON CONFLICT DO NOTHING', pmap[p.id], pmap[r.pid], r.qty)); }
    for (const r of S.rooms || []) (await run('INSERT INTO rooms VALUES(?,?,?,?) ON CONFLICT DO NOTHING', String(r.no), r.type || 'Standard', cents(r.rate || 1), ['vacant', 'occupied', 'dirty', 'maintenance'].includes(r.status) ? r.status : 'vacant'));
    for (const e of S.expenses || []) (await run('INSERT INTO expenses VALUES(?,?,?,?,?,?)', rid('x'), e.ts || now(), e.cat || 'Other', e.desc || 'Migrated', Math.max(1, cents(e.amount)), e.user || 'migration'));
    (await audit(u, 'IMPORT', JSON.stringify({ products: np, expenses: (S.expenses || []).length })));
    return { before, imported: { products: np, expenses: (S.expenses || []).length }, skipped: { sales: (S.sales || []).length, note: 'Historical sales/bookings are NOT imported automatically: keep the exported CSV/JSON as an archive.' }, verifiedProducts: (await q1('SELECT COUNT(*) c FROM products')).c }; }));
}


/* ---------------------------------------------------------------- export (replaces file backups: Supabase keeps the real backups) */
const EXPORT_TABLES = ['products', 'recipes', 'rooms', 'bookings', 'sales', 'sale_items', 'payments', 'charges', 'stock_moves', 'expenses', 'shifts', 'price_log'];
async function exportAll(u) {
  await need(u, 'users'); const out = { exported_at: now() };
  for (const t of EXPORT_TABLES) out[t] = await q('SELECT * FROM ' + t);
  out.users = await q('SELECT id,username,name,role,active,created_at FROM users');   // never hashes
  await audit(u, 'export', ''); return out;
}

/* ---------------------------------------------------------------- HTTP */
const ROUTES = {
  'POST /api/sale': sale, 'POST /api/settle': settle, 'POST /api/void': voidSale, 'POST /api/kitchen': kitchen,
  'POST /api/room/reserve': reserve, 'POST /api/room/checkin': checkin, 'POST /api/room/checkout': checkout, 'POST /api/room/extend': extend, 'POST /api/room/cancel': cancelBooking, 'POST /api/room/pay': folioPay, 'POST /api/room/status': roomStatus,
  'POST /api/stock/receive': receive, 'POST /api/stock/adjust': adjust, 'POST /api/product/edit': editProduct, 'POST /api/product/create': createProduct, 'POST /api/product/recipe': setRecipe, 'POST /api/room/create': roomCreate,
  'POST /api/expense': expense, 'POST /api/shift/open': shiftOpen, 'POST /api/shift/close': shiftClose,
  'POST /api/user/create': userCreate, 'POST /api/user/toggle': userToggle, 'POST /api/user/reset': userReset, 'POST /api/me/password': changeOwnPassword,
  'POST /api/admin/import': (u, b) => importLegacy(u, b),
  'GET /api/admin/export': u => exportAll(u),
  'GET /api/state': u => snapshot(u),
  'GET /api/report': (u, _b, url) => report(u, url.searchParams.get('from'), url.searchParams.get('to'))
};
function send(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(body); }
function readBody(req) {
  if (req.body !== undefined && req.body !== null) { if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body); try { return Promise.resolve(JSON.parse(String(req.body) || '{}')); } catch (e) { return Promise.reject(new HttpError(400, 'Invalid JSON')); } }
  return new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > 2e6) { no(new HttpError(413, 'Request too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString()) : {}); } catch (e) { no(new HttpError(400, 'Invalid JSON')); } }); });
}
async function handler(req, res) {
  const url = new URL(req.url, 'http://x'); const rewritten = url.searchParams.get('__p');   // vercel.json rewrites /api/* -> /api/index?__p=*
  const pathname = rewritten != null ? '/api/' + rewritten.replace(/^\/+/, '') : url.pathname, key = req.method + ' ' + pathname;
  const fail = e => { const s = e.status || 500; if (s === 500) console.error(e); send(res, s, JSON.stringify({ ok: false, error: s === 500 ? (/violates|append-only|cannot be deleted/i.test(e.message) ? 'Rejected by database rules: ' + e.message : 'Server error - nothing was saved.') : e.message })); };
  const store = { ip: String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim(), client: null };
  return als.run(store, async () => { try {
    if (!pathname.startsWith('/api/')) return send(res, 404, '{"ok":false,"error":"Not found"}');
    if (key === 'GET /api/status') return send(res, 200, JSON.stringify({ ok: true, data: { needsSetup: (await q1('SELECT COUNT(*) c FROM users')).c === 0 } }));
    if (req.method === 'POST' && (req.headers['x-pos'] !== '1' || !/application\/json/.test(req.headers['content-type'] || ''))) throw new HttpError(403, 'Bad request origin');
    if (key === 'POST /api/login') { const b = await readBody(req); return send(res, 200, JSON.stringify({ ok: true, data: await login(null, b, req, res) })); }
    if (key === 'POST /api/setup') { const b = await readBody(req); const d = await tx(async () => { if ((await q1('SELECT COUNT(*) c FROM users')).c) bad('Setup is already complete.', 403); return userCreate({ id: null, name: 'setup', role: 'admin' }, { ...b, role: 'admin' }); }); return send(res, 200, JSON.stringify({ ok: true, data: d })); }
    const u = await sessionUser(req); if (!u) throw new HttpError(401, 'Please sign in.');
    if (key === 'POST /api/logout') { await run('DELETE FROM sessions WHERE token_hash=?', u.th); res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (process.env.COOKIE_SECURE === '0' ? '' : '; Secure')); return send(res, 200, '{"ok":true,"data":{}}'); }
    const fn = ROUTES[key]; if (!fn) throw new HttpError(404, 'Not found');
    const b = req.method === 'POST' ? await readBody(req) : {}; return send(res, 200, JSON.stringify({ ok: true, data: await fn(u, b, url) }));
  } catch (e) { fail(e); } });
}
module.exports = handler;
module.exports.handler = handler;
