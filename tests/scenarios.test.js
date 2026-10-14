'use strict';
/* The 15 mandatory scenarios from the audit brief, run against a real Postgres database. */
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const { fresh, T, dayPlus, stockOf, sellBar, sellRest, PW } = H;
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

test.after(async () => { await H.stopServer(); });

test('1. cash sale: receipt data, salesperson, stock deduction, payment row', async () => {
  const x = await fresh(), { C, U, P, db } = x;
  const r = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]);
  assert.equal(r.status, 200); assert.equal(r.data.total, 600);
  const st = (await C.cashier.get('/api/state')).data, s = st.sales.find(s => s.id === r.data.id);
  assert.equal(s.total, 600); assert.equal(s.staffName, 'Bartender Person'); assert.equal(s.by, 'Cashier Person'); assert.equal(s.items[0].qty, 2);
  assert.equal(await stockOf(db, P.tusker), 18);
  const pay = (await db.query('select method,amount_c,kind,user_id from payments where ref_id=$1', [r.data.id])).rows;
  assert.deepEqual(pay.map(p => [p.method, Number(p.amount_c), p.kind]), [['Cash', 60000, 'payment']]);
  assert.equal(pay[0].user_id, U.cashier);
  const mv = (await db.query('select qty from stock_moves where ref=$1', [r.data.id])).rows; assert.equal(mv.length, 1); assert.equal(Number(mv[0].qty), -2);
  await db.end();
});

test('2. M-Pesa, Card and Split sales record the right payment rows', async () => {
  const x = await fresh(), { C, P, db } = x;
  const a = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 1 }], 'M-Pesa'), b = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 1 }], 'Card');
  const c = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }, { pid: P.cola, qty: 1 }], 'Split', { cash: 300, mpesa: 400 });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
  const m = async id => (await db.query('select method,amount_c from payments where ref_id=$1 order by method', [id])).rows.map(r => [r.method, Number(r.amount_c)]);
  assert.deepEqual(await m(a.data.id), [['M-Pesa', 30000]]); assert.deepEqual(await m(b.data.id), [['Card', 30000]]);
  assert.deepEqual(await m(c.data.id), [['Cash', 30000], ['M-Pesa', 40000]]);
  const bad = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 1 }], 'Split', { cash: 100, mpesa: 100 });
  assert.equal(bad.status, 400, 'split not matching the total must be refused');
  await db.end();
});

test('3. partial payments leave the right balance; overpayment is refused', async () => {
  const x = await fresh(), { C, db } = x;
  const s = await sellRest(C.waiter, x, [{ pid: x.P.tea, qty: 5 }], 'Cash', { later: true }); assert.equal(s.status, 200); // 400
  const bal = async () => (await C.cashier.get('/api/state')).data.sales.find(z => z.id === s.data.id).balance;
  assert.equal(await bal(), 400);
  assert.equal((await C.cashier.post('/api/settle', { saleId: s.data.id, amount: 150, method: 'Cash', idem: 'a1' })).data.balance, 250);
  assert.equal((await C.cashier.post('/api/settle', { saleId: s.data.id, amount: 300, method: 'Cash', idem: 'a2' })).status, 400);
  assert.equal(await bal(), 250);
  assert.equal((await C.cashier.post('/api/settle', { saleId: s.data.id, amount: 250, method: 'M-Pesa', idem: 'a3' })).data.balance, 0);
  assert.equal(await bal(), 0);
  assert.equal((await db.query('select pay_mode from sales where id=$1', [s.data.id])).rows[0].pay_mode, 'paid');
  assert.equal((await C.cashier.post('/api/settle', { saleId: s.data.id, amount: 1, method: 'Cash', idem: 'a4' })).status, 400);
  await db.end();
});

test('4. the same sale submitted twice (also in parallel) is recorded once', async () => {
  const x = await fresh(), { C, P, db } = x, token = T('dup');
  const body = { token, dept: 'bar', items: [{ pid: P.tusker, qty: 3 }], staffId: x.U.bartender, method: 'Cash' };
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => C.cashier.post('/api/sale', body)));
  assert.ok(rs.every(r => r.status === 200)); assert.equal(new Set(rs.map(r => r.data.id)).size, 1);
  assert.equal(rs.filter(r => !r.data.duplicate).length, 1);
  assert.equal((await db.query('select count(*)::int c from sales')).rows[0].c, 1);
  assert.equal(await stockOf(db, P.tusker), 17);
  assert.equal((await db.query("select count(*)::int c from payments where kind='payment'")).rows[0].c, 1);
  // duplicate payment request
  const s = await sellRest(C.waiter, x, [{ pid: P.tea, qty: 5 }], 'Cash', { later: true });
  const ps = await Promise.all([1, 2, 3].map(() => C.cashier.post('/api/settle', { saleId: s.data.id, amount: 100, method: 'Cash', idem: 'same' })));
  assert.equal(ps.filter(p => p.data && p.data.duplicate).length, 2);
  assert.equal((await db.query('select count(*)::int c from payments where ref_id=$1', [s.data.id])).rows[0].c, 1);
  await db.end();
});

test('5. void/refund reverses payments and stock; double void and unapproved void are refused', async () => {
  const x = await fresh(), { C, P, db } = x;
  const r = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 4 }], 'M-Pesa'); assert.equal(await stockOf(db, P.tusker), 16);
  const noAppr = await C.cashier.post('/api/void', { saleId: r.data.id, reason: 'mistake' }); assert.equal(noAppr.status, 403);
  const wrong = await C.cashier.post('/api/void', { saleId: r.data.id, reason: 'mistake', approver: { username: 'manager', password: 'nope-nope' } }); assert.equal(wrong.status, 403);
  const weak = await C.cashier.post('/api/void', { saleId: r.data.id, reason: 'mistake', approver: { username: 'bartender', password: PW } }); assert.equal(weak.status, 403, 'a bartender cannot approve voids');
  assert.equal(await stockOf(db, P.tusker), 16);
  const ok = await C.cashier.post('/api/void', { saleId: r.data.id, reason: 'customer left', approver: { username: 'manager', password: PW } }); assert.equal(ok.status, 200);
  assert.equal(await stockOf(db, P.tusker), 20);
  const net = (await db.query("select coalesce(sum(amount_c),0)::int s from payments where ref_id=$1", [r.data.id])).rows[0].s; assert.equal(net, 0);
  assert.equal((await db.query("select count(*)::int c from payments where ref_id=$1 and kind='refund' and method='M-Pesa'", [r.data.id])).rows[0].c, 1);
  assert.equal((await C.manager.post('/api/void', { saleId: r.data.id, reason: 'again' })).status, 400, 'double void');
  assert.equal(await stockOf(db, P.tusker), 20);
  await db.end();
});

test('6. unauthorised discount/price change, refund, deletion, admin actions are blocked', async () => {
  const x = await fresh(), { C, P, db } = x;
  // price change by cashier
  assert.equal((await C.cashier.post('/api/product/edit', { id: P.tusker, price: 1, cost: 0, reorder: 1, cat: 'Beer', reason: 'x', password: PW })).status, 403);
  // client-supplied price / total / discount are ignored
  const r = await C.cashier.post('/api/sale', { token: T(), dept: 'bar', items: [{ pid: P.tusker, qty: 1, price: 1, price_c: 1 }], total: 1, discount: 299, staffId: x.U.bartender, method: 'Cash' });
  assert.equal(r.data.total, 300);
  // refund without permission, user management, export, import, reports, expense
  for (const [m, p, b] of [['POST', '/api/user/create', { username: 'evil', name: 'E', role: 'admin', password: PW + 'x' }], ['GET', '/api/admin/export'], ['POST', '/api/admin/import', { products: [] }], ['GET', '/api/report?from=2026-01-01&to=2026-12-31'], ['POST', '/api/expense', { cat: 'x', desc: 'x', amount: 5 }], ['POST', '/api/user/toggle', { id: x.U.manager }], ['POST', '/api/user/reset', { id: x.U.admin, password: 'Another-pass-9' }]]) {
    const res = await C.cashier.call(m, p, b); assert.equal(res.status, 403, p);
  }
  assert.equal((await db.query("select count(*)::int c from users where username='evil'")).rows[0].c, 0);
  // unauthenticated
  const anon = H.client(); assert.equal((await anon.get('/api/state')).status, 401); assert.equal((await anon.post('/api/sale', {})).status, 401);
  // CSRF guard: missing X-POS header
  for (const headers of [{ cookie: C.admin.cookie, 'content-type': 'application/json' }, { cookie: C.admin.cookie, 'content-type': 'text/plain', 'x-pos': '1' }]) {
    const raw = await fetch(H.url() + '/api/expense', { method: 'POST', headers, body: JSON.stringify({ cat: 'x', desc: 'csrf', amount: 5 }) });
    assert.equal(raw.status, 403, 'cross-site style POST without the X-POS header / JSON content type is rejected');
  }
  assert.equal((await db.query("select count(*)::int c from expenses where descr='csrf'")).rows[0].c, 0);
  // database layer: ledger is append-only, sales/bookings cannot be deleted even by a rogue query
  await assert.rejects(db.query("update payments set amount_c=1"), /append-only/);
  await assert.rejects(db.query("delete from payments"), /cannot be deleted/);
  await assert.rejects(db.query("delete from sales"), /cannot be deleted/);
  await assert.rejects(db.query("update stock_moves set qty=0"), /append-only/);
  await assert.rejects(db.query("delete from audit_log"), /cannot be deleted/);
  // DENIED attempts are audited
  assert.ok((await db.query("select count(*)::int c from audit_log where action='DENIED'")).rows[0].c >= 5);
  await db.end();
});

test('7. overselling is refused atomically (nothing partly saved), also under concurrency', async () => {
  const x = await fresh(), { C, P, db } = x;
  const r = await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }, { pid: P.tusker, qty: 21 }]);
  assert.equal(r.status, 409); assert.match(r.error, /Not enough Tusker/);
  assert.equal(await stockOf(db, P.cola), 20); assert.equal(await stockOf(db, P.tusker), 20);
  assert.equal((await db.query('select count(*)::int c from sales')).rows[0].c, 0);
  assert.equal((await db.query("select count(*)::int c from stock_moves where reason like 'Sale%'")).rows[0].c, 0);
  // last unit, 5 simultaneous buyers: exactly one wins
  await C.admin.post('/api/stock/adjust', { pid: P.cola, counted: 1, reason: 'count', idem: T('adj') });
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }])));
  assert.equal(rs.filter(r => r.status === 200).length, 1); assert.equal(rs.filter(r => r.status === 409).length, 4);
  assert.equal(await stockOf(db, P.cola), 0);
  await db.end();
});

test('8. recipe dishes deduct ingredients, never themselves; void restocks ingredients', async () => {
  const x = await fresh(), { C, P, db } = x;
  const r = await sellRest(C.waiter, x, [{ pid: P.nyama, qty: 3 }]); assert.equal(r.status, 200);
  assert.equal(await stockOf(db, P.beef), 8.5); assert.equal(await stockOf(db, P.nyama), 0);
  const big = await sellRest(C.waiter, x, [{ pid: P.nyama, qty: 20 }]); assert.equal(big.status, 409); assert.equal(await stockOf(db, P.beef), 8.5);
  const v = await C.manager.post('/api/void', { saleId: r.data.id, reason: 'cancelled before cooking' }); assert.equal(v.status, 200); assert.equal(v.data.status, 'cancelled');
  assert.equal(await stockOf(db, P.beef), 10);
  // cost snapshot = ingredient cost
  const r2 = await sellRest(C.waiter, x, [{ pid: P.nyama, qty: 2 }]);
  assert.equal(Number((await db.query('select cost_c from sale_items where sale_id=$1', [r2.data.id])).rows[0].cost_c), 45000);
  // food already prepared: not restocked
  await C.kitchen.post('/api/kitchen', { saleId: r2.data.id, status: 'preparing' });
  const v2 = await C.manager.post('/api/void', { saleId: r2.data.id, reason: 'guest left' }); assert.equal(v2.data.status, 'void'); assert.equal(await stockOf(db, P.beef), 9);
  // illegal kitchen transition
  const r3 = await sellRest(C.waiter, x, [{ pid: P.tea, qty: 1 }]);
  assert.equal((await C.kitchen.post('/api/kitchen', { saleId: r3.data.id, status: 'served' })).status, 400);
  await db.end();
});

test('9. overlapping reservations created concurrently: only one may succeed', async () => {
  const x = await fresh(), { C, db } = x;
  const b = i => ({ room: '1', guest: 'G' + i, in: dayPlus(1), out: dayPlus(4 + (i % 2)) });
  const rs = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(i => C.receptionist.post('/api/room/reserve', b(i))));
  assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.status))); assert.equal(rs.filter(r => r.status === 409).length, 7);
  // back-to-back stays are allowed (checkout day == arrival day)
  assert.equal((await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'Next', in: dayPlus(4), out: dayPlus(6) })).status, 200);
  // extending into another booking is refused
  const nxt = (await C.receptionist.get('/api/state')).data.bookings.find(b => b.guest === 'Next');
  const first = (await C.receptionist.get('/api/state')).data.bookings.find(b => b.guest.startsWith('G'));
  assert.equal((await C.receptionist.post('/api/room/extend', { bookingId: first.id, out: dayPlus(8) })).status, 409);
  // a cancelled booking frees the room
  await C.receptionist.post('/api/room/cancel', { bookingId: first.id, reason: 'changed mind' });
  assert.equal((await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'After', in: dayPlus(1), out: dayPlus(3) })).status, 200);
  assert.ok(nxt);
  await db.end();
});

test('10. checkout with an outstanding balance: refused, approval required, debt shows as receivable', async () => {
  const x = await fresh(), { C, P, db } = x;
  const rs = await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'Debtor', in: dayPlus(0), out: dayPlus(2) }); const id = rs.data.id;
  assert.equal((await C.receptionist.post('/api/room/checkin', { bookingId: id })).status, 200);
  await C.receptionist.post('/api/room/pay', { bookingId: id, amount: 1000, method: 'Cash', idem: T('d') });
  const co = await C.receptionist.post('/api/room/checkout', { bookingId: id }); assert.equal(co.status, 409); assert.match(co.error, /Outstanding balance 4000/); // 2 nights x 2500 - 1000
  assert.equal((await C.receptionist.post('/api/room/checkout', { bookingId: id, allowDebt: true })).status, 403, 'receptionist cannot approve debt');
  assert.equal((await db.query("select status from bookings where id=$1", [id])).rows[0].status, 'in');
  assert.equal((await db.query("select count(*)::int c from charges where kind='room'")).rows[0].c, 0, 'refused checkout leaves no half-posted room charge');
  const ok = await C.manager.post('/api/room/checkout', { bookingId: id, allowDebt: true }); assert.equal(ok.status, 200); assert.equal(ok.data.balance, 4000);
  const rep = (await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data;
  assert.equal(rep.rev.lodging, 5000); assert.equal(rep.outBookings, 4000); assert.equal(rep.out, 4000);
  // settle the debt after checkout; cannot overpay
  assert.equal((await C.receptionist.post('/api/room/pay', { bookingId: id, amount: 5000, method: 'Cash', idem: T('o') })).status, 400);
  assert.equal((await C.receptionist.post('/api/room/pay', { bookingId: id, amount: 4000, method: 'Card', idem: T('p') })).status, 200);
  assert.equal((await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data.out, 0);
  // bar order posted to a room folio is billed once and reversed on void
  const r2 = await C.receptionist.post('/api/room/reserve', { room: '2', guest: 'Resident', in: dayPlus(0), out: dayPlus(1) }); await C.receptionist.post('/api/room/checkin', { bookingId: r2.data.id });
  const sale = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }], 'Room', { bookingId: r2.data.id }); assert.equal(sale.status, 200);
  let f = (await C.manager.get('/api/state')).data.bookings.find(b => b.id === r2.data.id).folio; assert.equal(f.ch, 600);
  await C.manager.post('/api/void', { saleId: sale.data.id, reason: 'wrong room' });
  f = (await C.manager.get('/api/state')).data.bookings.find(b => b.id === r2.data.id).folio; assert.equal(f.ch, 0);
  await db.end();
});

test('11. daily sales, refunds, expenses and cash reconcile with the ledger', async () => {
  const x = await fresh(), { C, P, db } = x, d = dayPlus(0);
  await C.cashier.post('/api/shift/open', { float: 1000 });
  const s1 = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]), s2 = await sellBar(C.cashier, x, [{ pid: P.cola, qty: 3 }], 'M-Pesa'), s3 = await sellRest(C.waiter, x, [{ pid: P.nyama, qty: 1 }], 'Card');
  await C.cashier.post('/api/void', { saleId: s2.data.id, reason: 'oops', approver: { username: 'manager', password: PW } });
  await C.admin.post('/api/expense', { cat: 'Supplies', desc: 'ice', amount: 250, idem: T('e') });
  const rep = (await C.admin.get('/api/report?from=' + d + '&to=' + d)).data;
  // independent recomputation straight from the tables
  const q = async (sql, a) => (await db.query(sql, a)).rows[0];
  const rev = Number((await q("select coalesce(sum(total_c),0) s from sales where status='active'")).s) / 100;
  assert.equal(rep.rv, rev); assert.equal(rep.rv, 600 + 900);
  const cogs = Number((await q("select coalesce(sum(round(i.qty*i.cost_c)),0) s from sale_items i join sales s on s.id=i.sale_id where s.status='active'")).s) / 100;
  assert.equal(rep.cost.bar + rep.cost.rest, cogs); assert.equal(rep.gp, rep.rv - cogs); assert.equal(rep.exp, 250); assert.equal(rep.np, rep.gp - 250);
  const cash = Number((await q("select sum(amount_c) s from payments where method='Cash'")).s) / 100; assert.equal(rep.pm.Cash, cash); assert.equal(rep.pm.Cash, 600);
  assert.equal(rep.pm['M-Pesa'], 0, 'sale 2 fully refunded'); assert.equal(rep.pm.Card, 900);
  const bySp = Object.values(rep.bySalesperson).reduce((a, b) => a + b, 0); assert.equal(bySp, rep.rv);
  assert.equal(rep.stockValue, Number((await q('select sum(round(stock*cost_c)) s from products')).s) / 100);
  // cashier's drawer: float + cash sales; refund of a non-cash sale does not touch it
  const sc = await C.cashier.post('/api/shift/close', { counted: 1600 }); assert.equal(sc.data.expected, 1600); assert.equal(sc.data.variance, 0);
  await db.end();
});

test('12. committed records survive an application restart (sessions too)', async () => {
  const x = await fresh(), { C, P, db } = x;
  const r = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]);
  await H.restartServer();
  const st = await C.cashier.get('/api/state'); assert.equal(st.status, 200, 'session cookie still valid after restart');
  assert.ok(st.data.sales.find(s => s.id === r.data.id)); assert.equal(st.data.products.find(p => p.id === P.tusker).stock, 18);
  await db.end();
});

test('13. a failure in the middle of a sale leaves nothing behind', async () => {
  const x = await fresh(), { C, P, db } = x;
  process.env.POS_TEST_FAULT = 'after_stock';
  try { const r = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 5 }]); assert.equal(r.status, 500); assert.match(r.error, /nothing was saved/i); }
  finally { delete process.env.POS_TEST_FAULT; }
  assert.equal(await stockOf(db, P.tusker), 20); assert.equal((await db.query('select count(*)::int c from sales')).rows[0].c, 0);
  assert.equal((await db.query("select count(*)::int c from stock_moves where reason like 'Sale%'")).rows[0].c, 0);
  assert.equal((await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 5 }])).status, 200, 'the system recovers: next sale works');
  await db.end();
});

test('14. role matrix: every role gets exactly the permissions it should', async () => {
  const x = await fresh(), { C } = x;
  const M = [ // [method, path, allowed roles]
    ['POST', '/api/sale', ['admin', 'manager', 'cashier', 'bartender', 'waiter', 'receptionist']],
    ['POST', '/api/settle', ['admin', 'manager', 'cashier', 'receptionist']],
    ['POST', '/api/kitchen', ['admin', 'manager', 'waiter', 'kitchen']],
    ['POST', '/api/room/reserve', ['admin', 'manager', 'receptionist']], ['POST', '/api/room/checkout', ['admin', 'manager', 'receptionist']], ['POST', '/api/room/pay', ['admin', 'manager', 'cashier', 'receptionist']],
    ['POST', '/api/stock/receive', ['admin', 'manager', 'storekeeper']], ['POST', '/api/stock/adjust', ['admin', 'manager', 'storekeeper']],
    ['POST', '/api/product/edit', ['admin', 'manager']], ['POST', '/api/product/create', ['admin', 'manager']], ['POST', '/api/product/recipe', ['admin', 'manager']], ['POST', '/api/room/create', ['admin', 'manager']],
    ['POST', '/api/expense', ['admin', 'manager']], ['GET', '/api/report?from=2026-01-01&to=2026-01-02', ['admin', 'manager']],
    ['POST', '/api/shift/open', ['admin', 'manager', 'cashier', 'bartender', 'receptionist']],
    ['POST', '/api/user/create', ['admin']], ['POST', '/api/user/toggle', ['admin']], ['POST', '/api/user/reset', ['admin']], ['POST', '/api/admin/import', ['admin']], ['GET', '/api/admin/export', ['admin']],
    ['GET', '/api/state', Object.keys(C)]
  ];
  const roles = Object.keys(C);
  for (const [m, p, allowed] of M) for (const role of roles) {
    const res = await C[role].call(m, p, m === 'POST' ? {} : undefined);
    const denied = res.status === 403 && /Not permitted|approval required/i.test(res.error || ''); assert.equal(denied, !allowed.includes(role), `${role} ${m} ${p} -> ${res.status} ${res.error || ''}`);
  }
  // void: roles without the permission need a manager's credentials
  for (const role of roles) { const res = await C[role].post('/api/void', { saleId: 'none', reason: 'x' }); assert.equal(res.status === 403 && /approval required|Not permitted/i.test(res.error || ''), !['admin', 'manager'].includes(role), role + ' void ' + res.status + ' ' + res.error); }
  // an admin cannot lock the system out of its last admin or disable itself
  assert.equal((await C.admin.post('/api/user/toggle', { id: x.U.admin })).status, 400);
});

test('15. migrations are repeatable and preserve data on a disposable copy', async () => {
  const x = await fresh(), { C, P, db } = x;
  await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]); await sellRest(C.waiter, x, [{ pid: P.nyama, qty: 1 }], 'Card'); await C.admin.post('/api/expense', { cat: 'Other', desc: 'x', amount: 10, idem: T('m') });
  const tables = ['users', 'products', 'sales', 'sale_items', 'payments', 'stock_moves', 'expenses', 'bookings', 'rooms', 'audit_log', 'recipes'];
  const snap = async c => { const o = {}; for (const t of tables) o[t] = (await c.query(`select count(*)::int n, md5(string_agg(t::text, '|' order by t::text)) h from ${t} t`)).rows[0]; return o; };
  const before = await snap(db);
  // copy the populated database, then run every migration again on the copy
  const pgbin = '/usr/lib/postgresql/16/bin/', env = { ...process.env, PGPASSWORD: '' };
  const A = await H.dbClient(H.ADMIN_URL); await A.query('drop database if exists pos_copy'); await A.query('create database pos_copy'); await A.end();
  const dump = execFileSync(pgbin + 'pg_dump', ['-h', 'localhost', '-p', '54329', '-U', 'postgres', '--no-owner', 'pos_test'], { env, maxBuffer: 1e8 });
  const sql = path.join(require('os').tmpdir(), 'pos_copy.sql'); fs.writeFileSync(sql, dump);
  execFileSync(pgbin + 'psql', ['-q', '-h', 'localhost', '-p', '54329', '-U', 'postgres', '-d', 'pos_copy', '-v', 'ON_ERROR_STOP=1', '-f', sql], { env, stdio: 'pipe' });
  const copy = await H.dbClient('postgres://postgres@localhost:54329/pos_copy');
  for (let round = 0; round < 2; round++) for (const f of H.migrations()) await copy.query(fs.readFileSync(path.join(H.APP, 'supabase', 'migrations', f), 'utf8'));
  const after = await snap(copy);
  for (const t of tables) { assert.equal(after[t].n, before[t].n, t + ' row count'); }
  for (const t of ['users', 'products', 'rooms', 'recipes']) assert.equal(after[t].h, before[t].h, t + ' contents');
  // the append-only guarantees still hold on the migrated copy
  await assert.rejects(copy.query('update payments set amount_c=1'), /append-only/);
  await copy.end(); await db.end();
});
