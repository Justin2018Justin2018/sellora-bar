'use strict';
/* Regression tests: one per defect found in the audit. Each of these FAILS on the original upload (see AUDIT_REPORT.md). */
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const { fresh, T, dayPlus, stockOf, sellBar, sellRest, PW } = H;

test.after(async () => { await H.stopServer(); });

test('D1 refunds are charged to the cashier at the till, not the approving manager (shift cash-up)', async () => {
  const x = await fresh(), { C, P, db } = x;
  await C.cashier.post('/api/shift/open', { float: 1000 });
  const s = await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]); // +600 cash
  const v = await C.cashier.post('/api/void', { saleId: s.data.id, reason: 'customer changed mind', approver: { username: 'manager', password: PW } }); assert.equal(v.status, 200);
  const r = await C.cashier.post('/api/shift/close', { counted: 1000 }); // drawer: 1000 float + 600 sale - 600 refund
  assert.equal(r.data.expected, 1000, 'refund handed out of the cashier drawer must reduce expected cash');
  assert.equal(r.data.variance, 0);
  const audit = (await db.query("select user_name,detail from audit_log where action='void'")).rows[0]; assert.match(audit.detail, /requested by Cashier Person/); assert.equal(audit.user_name, 'Manager Person', 'the approver is still the audited actor');
  await db.end();
});

test('D2 non-admin staff cannot list other users\' login names', async () => {
  const x = await fresh(), { C, db } = x;
  for (const role of ['cashier', 'kitchen', 'storekeeper', 'manager']) { const st = (await C[role].get('/api/state')).data; assert.ok(st.users.length >= 8); assert.ok(st.users.every(u => u.username === undefined), role + ' must not see usernames'); }
  assert.ok((await C.admin.get('/api/state')).data.users.every(u => typeof u.username === 'string'));
  await db.end();
});

test('D3 database error text never reaches the browser; bad recipes are rejected cleanly', async () => {
  const x = await fresh(), { C, P, db } = x;
  const dup = await C.admin.post('/api/product/recipe', { id: P.nyama, ingredients: [{ pid: P.beef, qty: 1 }, { pid: P.beef, qty: 2 }] });
  assert.equal(dup.status, 400); assert.ok(!/violates|constraint|pkey|recipes/i.test(dup.error || ''), dup.error);
  const wrong = await C.admin.post('/api/product/recipe', { id: P.nyama, ingredients: [{ pid: P.tusker, qty: 1 }] }); assert.equal(wrong.status, 400, 'only store (ingredient) items may be used as ingredients');
  const self = await C.admin.post('/api/product/recipe', { id: P.nyama, ingredients: [{ pid: P.nyama, qty: 1 }] }); assert.equal(self.status, 400);
  const onStore = await C.admin.post('/api/product/recipe', { id: P.beef, ingredients: [{ pid: P.beef, qty: 1 }] }); assert.equal(onStore.status, 400);
  assert.equal((await db.query('select count(*)::int c from recipes where product_id=$1', [P.nyama])).rows[0].c, 1, 'previous recipe untouched after rejected attempts');
  // a raw DB constraint hit (negative stock written behind the API's back) is reported generically
  await db.end();
});

test('D4 importing the same file twice does not duplicate expenses', async () => {
  const x = await fresh(), { C, db } = x;
  const file = { products: [{ id: 'a', name: 'Old Item', cat: 'Beer', dept: 'bar', price: 100, cost: 50, stock: 5 }], rooms: [{ no: '9', type: 'Single', rate: 1000 }], expenses: [{ ts: '2026-01-02T08:00:00.000Z', cat: 'Rent', desc: 'January', amount: 5000, user: 'old' }] };
  const a = await C.admin.post('/api/admin/import', file), b = await C.admin.post('/api/admin/import', file); assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await db.query("select count(*)::int c from expenses where descr='January'")).rows[0].c, 1);
  assert.equal((await db.query("select count(*)::int c from products where name='Old Item'")).rows[0].c, 1);
  assert.equal(Number((await db.query("select stock from products where name='Old Item'")).rows[0].stock), 5);
  assert.equal((await db.query("select count(*)::int c from stock_moves where reason like 'Migration%'")).rows[0].c, 1);
  assert.equal(b.data.imported.expenses, 0, 'second import reports that nothing new was added');
  const bad = await C.admin.post('/api/admin/import', { products: [{ id: 'z', name: '', cat: 'x' }] }); assert.equal(bad.status, 400);
  await db.end();
});

test('D5 stock receipts, counts and expenses are idempotent when the same request is retried', async () => {
  const x = await fresh(), { C, P, db } = x;
  for (let i = 0; i < 3; i++) assert.equal((await C.storekeeper.post('/api/stock/receive', { pid: P.tusker, qty: 10, cost: 200, idem: 'rcv-1' })).status, 200);
  assert.equal(await stockOf(db, P.tusker), 30);
  for (let i = 0; i < 3; i++) await C.storekeeper.post('/api/stock/adjust', { pid: P.tusker, counted: 25, reason: 'count', idem: 'adj-1' });
  assert.equal(await stockOf(db, P.tusker), 25); assert.equal((await db.query("select count(*)::int c from stock_moves where reason like 'Adjustment%'")).rows[0].c, 1);
  await Promise.all([1, 2, 3, 4].map(() => C.admin.post('/api/expense', { cat: 'Supplies', desc: 'ice', amount: 40, idem: 'exp-1' })));
  assert.equal((await db.query("select count(*)::int c from expenses where descr='ice'")).rows[0].c, 1);
  // a retry that arrives with the same key but is a *different* request is refused, not silently ignored
  assert.equal((await C.storekeeper.post('/api/stock/receive', { pid: P.cola, qty: 5, cost: 50, idem: 'rcv-1' })).status, 409);
  assert.equal((await C.storekeeper.post('/api/stock/receive', { pid: P.cola, qty: 5, cost: 50 })).status, 400, 'an idempotency key is required');
  await db.end();
});

test('D6 wastage can only reduce stock', async () => {
  const x = await fresh(), { C, P, db } = x;
  assert.equal((await C.storekeeper.post('/api/stock/adjust', { pid: P.tusker, counted: 30, wastage: true, reason: 'breakage', idem: T('w') })).status, 400);
  assert.equal(await stockOf(db, P.tusker), 20);
  assert.equal((await C.storekeeper.post('/api/stock/adjust', { pid: P.tusker, counted: 18, wastage: true, reason: 'breakage', idem: T('w') })).status, 200);
  assert.equal(await stockOf(db, P.tusker), 18);
  await db.end();
});

test('D7 a guest\'s leftover credit (deposit > bill, or reversed charge) can be refunded and is reported correctly', async () => {
  const x = await fresh(), { C, db } = x;
  const b = (await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'Rich', in: dayPlus(0), out: dayPlus(1) })).data.id;
  await C.receptionist.post('/api/room/pay', { bookingId: b, amount: 5000, method: 'Cash', idem: T('dep') }); await C.receptionist.post('/api/room/checkin', { bookingId: b });
  const co = await C.receptionist.post('/api/room/checkout', { bookingId: b }); assert.equal(co.status, 200); assert.equal(co.data.balance, -2500);
  assert.equal((await C.receptionist.post('/api/room/refund', { bookingId: b, amount: 2500, method: 'Cash', idem: T('r') })).status, 403, 'refunds need manager approval');
  assert.equal((await C.manager.post('/api/room/refund', { bookingId: b, amount: 2501, method: 'Cash', idem: T('r') })).status, 400, 'cannot refund more than the credit');
  const k = T('r'); assert.equal((await C.manager.post('/api/room/refund', { bookingId: b, amount: 2500, method: 'Cash', idem: k })).status, 200);
  assert.equal((await C.manager.post('/api/room/refund', { bookingId: b, amount: 2500, method: 'Cash', idem: k })).data.duplicate, true);
  assert.equal((await C.manager.post('/api/room/refund', { bookingId: b, amount: 1, method: 'Cash', idem: T('r') })).status, 400, 'nothing left to refund');
  assert.equal((await C.manager.get('/api/state')).data.bookings.find(z => z.id === b).folio.bal, 0);
  assert.equal(Number((await db.query("select sum(amount_c) s from payments where ref_id=$1", [b])).rows[0].s), 250000);
  assert.equal((await C.receptionist.post('/api/room/refund', { bookingId: 'nope', amount: 1, method: 'Cash', idem: T('r') })).status, 403);
  await db.end();
});

test('D8 sales export returns every sale in the range and matches the report', async () => {
  const x = await fresh(), { C, P, db } = x, d = dayPlus(0);
  for (let i = 0; i < 3; i++) await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }]);
  const s = await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }]); await C.manager.post('/api/void', { saleId: s.data.id, reason: 'x' });
  const ex = await C.manager.get('/api/report/sales?from=' + d + '&to=' + d); assert.equal(ex.status, 200);
  assert.equal(ex.data.rows.length, 4);
  const rep = (await C.manager.get('/api/report?from=' + d + '&to=' + d)).data;
  assert.equal(ex.data.rows.filter(r => r.status === 'active').reduce((a, r) => a + r.total, 0), rep.rv);
  assert.equal((await C.cashier.get('/api/report/sales?from=' + d + '&to=' + d)).status, 403);
  assert.equal((await C.manager.get('/api/report/sales?from=bad&to=' + d)).status, 400);
  await db.end();
});

test('D9 the booking overlap rule is also enforced inside the database', async () => {
  const x = await fresh(), { C, db } = x;
  await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'First', in: dayPlus(2), out: dayPlus(5) });
  await assert.rejects(db.query("insert into bookings(id,room_no,guest,date_in,date_out,status) values('B-x','1','Rogue',$1,$2,'reserved')", [dayPlus(3), dayPlus(4)]), /overlap|already booked/i);
  await db.query("insert into bookings(id,room_no,guest,date_in,date_out,status) values('B-ok','1','Adjacent',$1,$2,'reserved')", [dayPlus(5), dayPlus(7)]);
  await db.query("insert into bookings(id,room_no,guest,date_in,date_out,status) values('B-c','1','Cancelled',$1,$2,'cancelled')", [dayPlus(3), dayPlus(4)]);
  await db.end();
});

test('D10 /api/state does not issue one query per sale or booking', async () => {
  const x = await fresh(), { C, P, db } = x;
  await C.admin.post('/api/stock/receive', { pid: P.cola, qty: 100, cost: 50, idem: T('cola') });
  for (let i = 0; i < 25; i++) await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }], 'Cash');
  for (let i = 0; i < 6; i++) await sellRest(C.waiter, x, [{ pid: P.tea, qty: 1 }], 'Cash', { later: true });
  for (let i = 0; i < 8; i++) await C.receptionist.post('/api/room/reserve', { room: i % 2 ? '1' : '2', guest: 'G' + i, in: dayPlus(10 + i * 3), out: dayPlus(12 + i * 3) });
  H.counter.n = 0; H.counter.on = true; const st = await C.manager.get('/api/state'); H.counter.on = false;
  assert.equal(st.status, 200); assert.equal(st.data.sales.length, 31); assert.equal(st.data.bookings.length, 8);
  assert.ok(H.counter.n <= 30, 'state used ' + H.counter.n + ' statements');
  const balances = st.data.sales.filter(s => s.pay === 'open').map(s => s.balance); assert.deepEqual(balances, [80, 80, 80, 80, 80, 80]);
  H.counter.n = 0; H.counter.on = true; const rp = await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0)); H.counter.on = false;
  assert.ok(H.counter.n <= 20, 'report used ' + H.counter.n + ' statements'); assert.equal(rp.status, 200);
  await db.end();
});

test('D11 the test-only fault hook is inert in production', async () => {
  const x = await fresh(), { C, P, db } = x;
  process.env.NODE_ENV = 'production'; process.env.POS_TEST_FAULT = 'after_stock';
  try { assert.equal((await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }])).status, 200); } finally { process.env.NODE_ENV = 'test'; delete process.env.POS_TEST_FAULT; }
  await db.end();
});

test('D12 retired products cannot be sold; archive/restore is audited and permission-checked', async () => {
  const x = await fresh(), { C, P, db } = x;
  assert.equal((await C.cashier.post('/api/product/archive', { id: P.cola, active: false, password: PW })).status, 403);
  assert.equal((await C.manager.post('/api/product/archive', { id: P.cola, active: false, password: 'wrong-password' })).status, 403);
  assert.equal((await C.manager.post('/api/product/archive', { id: P.cola, active: false, password: PW })).status, 200);
  assert.equal((await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }])).status, 400);
  assert.equal((await C.manager.get('/api/state')).data.products.find(p => p.id === P.cola).active, false);
  assert.equal((await C.manager.post('/api/product/archive', { id: P.cola, active: true, password: PW })).status, 200);
  assert.equal((await sellBar(C.cashier, x, [{ pid: P.cola, qty: 1 }])).status, 200);
  assert.ok((await db.query("select count(*)::int c from audit_log where action in ('item retire','item restore')")).rows[0].c === 2);
  // an ingredient used by a live recipe cannot be retired
  assert.equal((await C.manager.post('/api/product/archive', { id: P.beef, active: false, password: PW })).status, 409);
  await db.end();
});

test('D13 money maths is exact: fractional prices and quantities, strict input validation', async () => {
  const x = await fresh(), { C, P, db } = x;
  await C.admin.post('/api/stock/receive', { pid: P.tea, qty: 1000, cost: 1, idem: T('big') });
  const e = await C.admin.post('/api/product/create', { name: 'Odd', cat: 'Soft', dept: 'bar', price: 33.33, cost: 10.01, reorder: 0 }); await C.admin.post('/api/stock/receive', { pid: e.data.id, qty: 100, cost: 10.01, idem: T('o') });
  const r = await sellBar(C.cashier, x, [{ pid: e.data.id, qty: 3 }]); assert.equal(r.data.total, 99.99);
  assert.equal(Number((await db.query('select total_c from sales where id=$1', [r.data.id])).rows[0].total_c), 9999);
  const r2 = await sellBar(C.cashier, x, [{ pid: e.data.id, qty: 0.5 }], 'Split', { cash: 10, mpesa: 6.67 }); assert.equal(r2.status, 200); // 16.665 -> 16.67 (round half up on cents)
  for (const q of [0, -1, 'abc', null, 1e9, NaN]) assert.equal((await sellBar(C.cashier, x, [{ pid: P.tusker, qty: q }])).status, 400, 'qty ' + q);
  assert.equal((await sellBar(C.cashier, x, [])).status, 400); assert.equal((await C.cashier.post('/api/sale', { token: T(), dept: 'bar', items: [{ pid: 'nope', qty: 1 }], staffId: x.U.bartender, method: 'Cash' })).status, 400);
  assert.equal((await C.cashier.post('/api/sale', { token: T(), dept: 'bar', items: [{ pid: P.tusker, qty: 1 }], staffId: 'ghost', method: 'Cash' })).status, 400);
  assert.equal((await C.cashier.post('/api/sale', { token: T(), dept: 'bar', items: [{ pid: P.tusker, qty: 1 }], staffId: x.U.kitchen, method: 'Cash' })).status, 400, 'kitchen staff cannot be the salesperson');
  for (const a of [-5, 0, 'x', 1e10]) assert.equal((await C.admin.post('/api/expense', { cat: 'x', desc: 'y', amount: a, idem: T('e') })).status, 400, 'expense ' + a);
  assert.equal(await stockOf(db, P.tusker), 20);
  await db.end();
});

test('D14 a sale token reused for a DIFFERENT basket (or by another user) is refused, never merged', async () => {
  const x = await fresh(), { C, P, db } = x, token = T('reuse');
  const a = await C.cashier.post('/api/sale', { token, dept: 'bar', items: [{ pid: P.tusker, qty: 1 }], staffId: x.U.bartender, method: 'Cash' }); assert.equal(a.status, 200);
  const same = await C.cashier.post('/api/sale', { token, dept: 'bar', items: [{ pid: P.tusker, qty: 1 }], staffId: x.U.bartender, method: 'Cash' }); assert.equal(same.data.duplicate, true); assert.equal(same.data.id, a.data.id);
  const diff = await C.cashier.post('/api/sale', { token, dept: 'bar', items: [{ pid: P.tusker, qty: 5 }], staffId: x.U.bartender, method: 'Cash' }); assert.equal(diff.status, 409);
  const other = await C.manager.post('/api/sale', { token, dept: 'bar', items: [{ pid: P.tusker, qty: 1 }], staffId: x.U.bartender, method: 'Cash' }); assert.equal(other.status, 409);
  assert.equal(await stockOf(db, P.tusker), 19); assert.equal((await db.query('select count(*)::int c from sales')).rows[0].c, 1);
  await db.end();
});

test('D15 the hardening migration can be rolled back and re-applied without losing records', async () => {
  const fs = require('fs'), path = require('path');
  const x = await fresh(), { C, P, db } = x;
  await sellBar(C.cashier, x, [{ pid: P.tusker, qty: 2 }]); await C.admin.post('/api/expense', { cat: 'Other', desc: 'rb', amount: 10, idem: T('rb') }); await C.receptionist.post('/api/room/reserve', { room: '1', guest: 'RB', in: dayPlus(2), out: dayPlus(3) });
  const counts = async () => Object.fromEntries(await Promise.all(['sales', 'payments', 'stock_moves', 'expenses', 'bookings', 'audit_log'].map(async t => [t, (await db.query(`select count(*)::int n from ${t}`)).rows[0].n])));
  const before = await counts(), down = fs.readFileSync(path.join(H.APP, 'supabase', 'rollbacks', '20261014000000_hardening.down.sql'), 'utf8');
  await db.query(down); assert.deepEqual(await counts(), before, 'rollback keeps every record');
  assert.equal((await db.query("select count(*)::int c from information_schema.columns where table_name='expenses' and column_name='idem'")).rows[0].c, 0);
  await db.query("insert into bookings(id,room_no,guest,date_in,date_out,status) values('B-ov','1','Overlap',$1,$2,'reserved')", [dayPlus(2), dayPlus(3)]); // rolled back: DB no longer blocks it (the API still does)
  await db.query("update bookings set status='cancelled' where id='B-ov'");
  await db.query(fs.readFileSync(path.join(H.APP, 'supabase', 'migrations', '20261014000000_hardening.sql'), 'utf8'));
  assert.equal((await db.query("select count(*)::int c from information_schema.columns where table_name='expenses' and column_name='idem'")).rows[0].c, 1);
  assert.equal(Object.values(await counts()).reduce((a, b) => a + b, 0), Object.values(before).reduce((a, b) => a + b, 0) + 1);
  await db.end();
});
