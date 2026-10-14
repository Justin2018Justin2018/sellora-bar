'use strict';
/* Tusker keg: one 50-litre inventory item, sold as 500 ml glasses (KSh 70) and 1,500 ml jugs (KSh 210 / 250). Real Postgres. */
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const { fresh, T, dayPlus, stockOf, PW } = H;
const KEG = { name: 'Tusker Lager (keg)', size: 50, packCost: 5358, servings: [{ name: 'Tusker Glass 500 ml', ml: 500, price: 70 }, { name: 'Tusker Jug 1500 ml', ml: 1500, price: 210, options: [210, 250] }] };

test.after(async () => { await H.stopServer(); });

async function withKeg(kegs = 1) {
  const x = await fresh(); const r = await x.C.admin.post('/api/keg/setup', KEG); assert.equal(r.status, 200, JSON.stringify(r));
  x.keg = r.data.id; x.glass = r.data.servings[0]; x.jug = r.data.servings[1];
  if (kegs) assert.equal((await x.C.storekeeper.post('/api/keg/receive', { pid: x.keg, kegs, idem: T('k') })).status, 200);
  x.sell = (c, items, method = 'Cash', extra = {}) => c.post('/api/sale', { token: T(), dept: 'bar', items, staffId: x.U.bartender, method, ...extra });
  x.rep = async (c = x.C.manager) => (await c.get('/api/report/kegs?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data.kegs[0];
  return x;
}

test('K1 setup creates ONE keg item in litres plus glass/jug servings; it is idempotent and permission-checked', async () => {
  const x = await fresh(), { C, db } = x;
  assert.equal((await C.cashier.post('/api/keg/setup', KEG)).status, 403);
  const r = await C.manager.post('/api/keg/setup', KEG); assert.equal(r.status, 200);
  const again = await C.manager.post('/api/keg/setup', KEG); assert.equal(again.data.duplicate, true);
  assert.equal((await db.query("select count(*)::int c from products where lower(name) like 'tusker%keg%'")).rows[0].c, 1, 'a single keg inventory item');
  const k = (await db.query('select * from products where id=$1', [r.data.id])).rows[0];
  assert.equal(k.dept, 'store'); assert.equal(k.unit, 'L'); assert.equal(Number(k.pack_size), 50); assert.equal(Number(k.pack_cost_c), 535800); assert.equal(Number(k.cost_c), 10716, 'KSh 107.16 per litre'); assert.equal(Number(k.stock), 0);
  const rec = (await db.query('select p.name,r.qty from recipes r join products p on p.id=r.product_id where r.ingredient_id=$1 order by r.qty', [r.data.id])).rows.map(z => [z.name, Number(z.qty)]);
  assert.deepEqual(rec, [['Tusker Glass 500 ml', 0.5], ['Tusker Jug 1500 ml', 1.5]]);
  const st = (await C.manager.get('/api/state')).data, g = st.products.find(p => p.name === 'Tusker Glass 500 ml'), j = st.products.find(p => p.name === 'Tusker Jug 1500 ml');
  assert.equal(g.price, 70); assert.equal(j.price, 210); assert.deepEqual(j.priceOpts, [210, 250]); assert.equal(g.dept, 'bar');
  assert.equal((await C.manager.post('/api/keg/setup', { ...KEG, name: 'X', size: 0 })).status, 400);
  assert.equal((await C.manager.post('/api/keg/setup', { ...KEG, name: 'Y', servings: [{ name: 'Z', ml: 500, price: 300, options: [210, 250] }] })).status, 400, 'price must be one of its options');
  await db.end();
});

test('K2 receiving a keg adds 50 L at KSh 107.16/L; the request is idempotent', async () => {
  const x = await withKeg(0), { C, db } = x, k = T('rk');
  assert.equal((await C.storekeeper.post('/api/keg/receive', { pid: x.keg, kegs: 1, idem: k })).data.litres, 50);
  assert.equal((await C.storekeeper.post('/api/keg/receive', { pid: x.keg, kegs: 1, idem: k })).data.duplicate, true);
  assert.equal(await stockOf(db, x.keg), 50);
  assert.equal((await C.storekeeper.post('/api/keg/receive', { pid: x.keg, kegs: 2, idem: k })).status, 409);
  assert.equal((await C.cashier.post('/api/keg/receive', { pid: x.keg, kegs: 1, idem: T() })).status, 403);
  assert.equal((await C.storekeeper.post('/api/keg/receive', { pid: x.glass, kegs: 1, idem: T() })).status, 400, 'only keg items');
  const r = await x.rep(); assert.equal(r.capacity, 50); assert.equal(r.kegCost, 5358); assert.equal(r.costPerLitre, 107.16); assert.equal(r.remaining, 50); assert.equal(r.stockValue, 5358);
  await db.end();
});

test('K3 two glasses + one jug deduct EXACTLY 2.5 litres; cost, revenue and history are exact', async () => {
  const x = await withKeg(), { C, db } = x;
  const r = await x.sell(C.cashier, [{ pid: x.glass, qty: 2 }, { pid: x.jug, qty: 1 }]); assert.equal(r.status, 200); assert.equal(r.data.total, 350);
  assert.equal(await stockOf(db, x.keg), 47.5);
  const mv = (await db.query('select qty,user_name,ts,ref,reason from stock_moves where ref=$1', [r.data.id])).rows; assert.equal(mv.length, 1); assert.equal(Number(mv[0].qty), -2.5);
  assert.equal(mv[0].user_name, 'Cashier Person'); assert.ok(mv[0].ts && mv[0].reason.startsWith('Sale'));
  const items = (await db.query('select name,qty,price_c,cost_c from sale_items where sale_id=$1 order by name', [r.data.id])).rows.map(i => [i.name, Number(i.qty), Number(i.price_c), Number(i.cost_c)]);
  assert.deepEqual(items, [['Tusker Glass 500 ml', 2, 7000, 5358], ['Tusker Jug 1500 ml', 1, 21000, 16074]], 'cost per serving = litres x actual cost per litre');
  const k = await x.rep(); assert.equal(k.period.litresSold, 2.5); assert.equal(k.period.revenue, 350); assert.equal(k.period.cost, 267.9); assert.equal(k.period.grossProfit, 82.1); assert.equal(k.remaining, 47.5); assert.equal(k.lifetime.reconciled, true);
  const hist = (await C.manager.get('/api/state')).data.moves.find(z => z.ref === r.data.id); assert.equal(hist.qty, -2.5); assert.equal(hist.user, 'Cashier Person');
  await db.end();
});

test('K4 100 glasses consume exactly 50 L and bring in exactly KSh 7,000; the 101st is refused', async () => {
  for (const mode of ['one-sale', 'many-sales']) {
    const x = await withKeg(), { C, db } = x;
    if (mode === 'one-sale') assert.equal((await x.sell(C.cashier, [{ pid: x.glass, qty: 100 }])).data.total, 7000);
    else for (let i = 0; i < 100; i++) assert.equal((await x.sell(C.cashier, [{ pid: x.glass, qty: 1 }])).status, 200);
    assert.equal(await stockOf(db, x.keg), 0, mode);
    const one = await x.sell(C.cashier, [{ pid: x.glass, qty: 1 }]); assert.equal(one.status, 409); assert.equal(await stockOf(db, x.keg), 0);
    const k = await x.rep(); assert.equal(k.period.litresSold, 50); assert.equal(k.period.revenue, 7000); assert.equal(k.period.cost, 5358, 'whole keg cost'); assert.equal(k.period.grossProfit, 1642);
    const rp = (await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data; assert.equal(rp.rv, 7000); assert.equal(rp.cost.bar, 5358); assert.equal(rp.gp, 1642);
    assert.equal((await db.query("select coalesce(sum(-qty),0)::float s from stock_moves where product_id=$1 and ref is not null", [x.keg])).rows[0].s, 50);
    await db.end();
  }
});

test('K5 the administrator picks the jug price (210 or 250); stock deduction never changes; old sales keep their price', async () => {
  const x = await withKeg(), { C, db } = x;
  const edit = (c, price, pw = PW) => c.post('/api/product/edit', { id: x.jug, price, cost: 0, reorder: 0, cat: 'Draught', reason: 'jug price', password: pw });
  const a = await x.sell(C.cashier, [{ pid: x.jug, qty: 1 }]); assert.equal(a.data.total, 210);
  assert.equal((await edit(C.manager, 250)).status, 403, 'a manager cannot change the jug price');
  assert.equal((await edit(C.admin, 230)).status, 400, 'only 210 or 250'); assert.equal((await edit(C.admin, 250, 'wrong-password')).status, 403);
  assert.equal((await edit(C.admin, 250)).status, 200);
  const b = await x.sell(C.cashier, [{ pid: x.jug, qty: 1 }]); assert.equal(b.data.total, 250);
  assert.equal(await stockOf(db, x.keg), 47, 'two jugs = 3.0 L at either price');
  for (const id of [a.data.id, b.data.id]) assert.equal(Number((await db.query('select qty from stock_moves where ref=$1', [id])).rows[0].qty), -1.5);
  assert.equal((await edit(C.admin, 210)).status, 200); assert.equal((await x.sell(C.cashier, [{ pid: x.jug, qty: 1 }])).data.total, 210);
  const k = await x.rep(); assert.equal(k.period.revenue, 210 + 250 + 210); assert.equal(k.period.litresSold, 4.5); assert.equal(Math.round(k.period.cost * 100), 3 * 16074, 'cost of 3 jugs at KSh 107.16/L');
  assert.equal((await db.query("select count(*)::int c from price_log where item='Tusker Jug 1500 ml'")).rows[0].c, 2, 'price changes are logged');
  // the manager may still change other fields (reorder level) without touching the price
  assert.equal((await C.manager.post('/api/product/edit', { id: x.jug, price: 210, cost: 0, reorder: 3, cat: 'Draught', reason: '', password: PW })).status, 200);
  await db.end();
});

test('K6 not enough beer: refused atomically, never negative; mixed baskets are all-or-nothing', async () => {
  const x = await withKeg(), { C, db } = x;
  await C.storekeeper.post('/api/stock/adjust', { pid: x.keg, counted: 1.2, reason: 'count', idem: T('a') });
  const n0 = (await db.query('select count(*)::int c from sales')).rows[0].c;
  const jug = await x.sell(C.cashier, [{ pid: x.jug, qty: 1 }]); assert.equal(jug.status, 409); assert.match(jug.error, /Not enough Tusker Lager/);
  const mix = await x.sell(C.cashier, [{ pid: x.glass, qty: 2 }, { pid: x.jug, qty: 1 }]); assert.equal(mix.status, 409); // needs 2.5
  assert.equal(await stockOf(db, x.keg), 1.2); assert.equal((await db.query('select count(*)::int c from sales')).rows[0].c, n0);
  assert.equal((await db.query("select count(*)::int c from stock_moves where reason like 'Sale%'")).rows[0].c, 0);
  assert.equal((await x.sell(C.cashier, [{ pid: x.glass, qty: 2 }])).status, 200); assert.equal(await stockOf(db, x.keg), 0.2);
  assert.equal((await x.sell(C.cashier, [{ pid: x.glass, qty: 1 }])).status, 409, '0.2 L cannot serve a 0.5 L glass');
  assert.equal(await stockOf(db, x.keg), 0.2);
  await assert.rejects(db.query('update products set stock=-1 where id=$1', [x.keg]), /check constraint/i, 'the database itself forbids negative stock');
  await db.end();
});

test('K7 void/refund puts the litres back once, reverses money and revenue; history shows both movements', async () => {
  const x = await withKeg(), { C, db } = x;
  const a = await x.sell(C.cashier, [{ pid: x.glass, qty: 2 }, { pid: x.jug, qty: 1 }], 'M-Pesa'), b = await x.sell(C.cashier, [{ pid: x.glass, qty: 4 }]);
  assert.equal(await stockOf(db, x.keg), 45.5, '50 L - 2.5 L - 2 L');
  const v = await C.cashier.post('/api/void', { saleId: a.data.id, reason: 'wrong order', approver: { username: 'manager', password: PW } }); assert.equal(v.status, 200);
  assert.equal(await stockOf(db, x.keg), 48, '2.5 L returned to the keg: only the 4 glasses (2 L) remain sold');
  assert.equal((await C.manager.post('/api/void', { saleId: a.data.id, reason: 'again' })).status, 400); assert.equal(await stockOf(db, x.keg), 48);
  assert.equal(Number((await db.query("select coalesce(sum(amount_c),0) s from payments where ref_id=$1", [a.data.id])).rows[0].s), 0);
  const mv = (await db.query('select qty,reason,user_name from stock_moves where ref=$1 order by ts,id', [a.data.id])).rows; assert.deepEqual(mv.map(z => Number(z.qty)), [-2.5, 2.5]); assert.match(mv[1].reason, /^Reversal/);
  const k = await x.rep(); assert.equal(k.period.litresSold, 2); assert.equal(k.period.revenue, 280); assert.equal(Math.round(k.period.cost * 100), 4 * 5358); assert.equal(k.lifetime.sold, 2); assert.equal(k.lifetime.reconciled, true);
  const rp = (await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data; assert.equal(rp.rv, 280, 'voided sale is excluded from revenue');
  assert.equal(b.status, 200); await db.end();
});

test('K8 duplicate submissions and simultaneous sales cannot over-deduct', async () => {
  const x = await withKeg(), { C, db } = x, token = T('dup');
  const body = { token, dept: 'bar', items: [{ pid: x.jug, qty: 2 }], staffId: x.U.bartender, method: 'Cash' };
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => C.cashier.post('/api/sale', body)));
  assert.equal(rs.filter(r => !r.data.duplicate).length, 1); assert.equal(await stockOf(db, x.keg), 47);
  assert.equal((await db.query('select count(*)::int c from stock_moves where product_id=$1 and ref is not null', [x.keg])).rows[0].c, 1);
  await C.storekeeper.post('/api/stock/adjust', { pid: x.keg, counted: 2, reason: 'count', idem: T('a') });
  const many = await Promise.all(Array.from({ length: 8 }, () => x.sell(C.cashier, [{ pid: x.glass, qty: 1 }])));
  assert.equal(many.filter(r => r.status === 200).length, 4, '2 L = exactly four 500 ml glasses'); assert.equal(many.filter(r => r.status === 409).length, 4); assert.equal(await stockOf(db, x.keg), 0);
  await db.end();
});

test('K9 keg report reconciles: received - sold + adjustments = remaining, and revenue ties to the sales report', async () => {
  const x = await withKeg(2), { C, db } = x; // 100 L
  for (let i = 0; i < 10; i++) await x.sell(C.cashier, [{ pid: x.glass, qty: 3 }, { pid: x.jug, qty: 1 }], i % 2 ? 'Cash' : 'Card');
  await C.storekeeper.post('/api/stock/adjust', { pid: x.keg, counted: 68, wastage: true, reason: 'spillage', idem: T('w') });
  const s = await x.sell(C.cashier, [{ pid: x.jug, qty: 1 }]); await C.manager.post('/api/void', { saleId: s.data.id, reason: 'x' });
  const k = await x.rep();
  assert.equal(k.lifetime.received, 100); assert.equal(k.lifetime.sold, 30); assert.equal(k.lifetime.adjusted, -2); assert.equal(k.lifetime.remaining, 68); assert.equal(k.lifetime.reconciled, true);
  assert.equal(k.period.litresSold, 30); assert.equal(k.period.revenue, 10 * (210 + 210)); assert.equal(Math.round(k.period.cost * 100), 10 * (3 * 5358 + 16074));
  const rp = (await C.manager.get('/api/report?from=' + dayPlus(0) + '&to=' + dayPlus(0))).data; assert.equal(rp.rv, k.period.revenue); assert.equal(rp.cost.bar, k.period.cost); assert.equal(rp.gp, k.period.grossProfit);
  assert.equal(k.period.servings.length, 2); assert.equal(k.period.servings.find(z => z.name.includes('Glass')).qty, 30);
  assert.equal((await C.cashier.get('/api/report/kegs?from=' + dayPlus(0) + '&to=' + dayPlus(0))).status, 403);
  assert.equal((await C.manager.get('/api/report/kegs?from=nope&to=' + dayPlus(0))).status, 400);
  await db.end();
});

test('K10 a second keg at a new price: servings are costed at the weighted average; earlier sales keep their cost', async () => {
  const x = await withKeg(), { C, db } = x;
  const a = await x.sell(C.cashier, [{ pid: x.glass, qty: 60 }]); assert.equal(await stockOf(db, x.keg), 20);
  assert.equal((await C.storekeeper.post('/api/keg/receive', { pid: x.keg, kegs: 1, packCost: 5700, idem: T('k2') })).status, 200);
  const cpl = Number((await db.query('select cost_c from products where id=$1', [x.keg])).rows[0].cost_c); assert.equal(cpl, Math.round((20 * 10716 + 570000) / 70)); // 11205
  const b = await x.sell(C.cashier, [{ pid: x.glass, qty: 1 }]);
  assert.equal(Number((await db.query('select cost_c from sale_items where sale_id=$1', [a.data.id])).rows[0].cost_c), 5358); assert.equal(Number((await db.query('select cost_c from sale_items where sale_id=$1', [b.data.id])).rows[0].cost_c), Math.round(0.5 * cpl));
  const k = await x.rep(); assert.equal(k.kegCost, 5700); assert.equal(k.lifetime.reconciled, true); assert.equal(k.remaining, 69.5);
  await db.end();
});

test('K11 sales, stock, costs and history persist across an application restart', async () => {
  const x = await withKeg(), { C, db } = x;
  const r = await x.sell(C.cashier, [{ pid: x.glass, qty: 2 }, { pid: x.jug, qty: 1 }]); const before = await x.rep();
  await H.restartServer();
  const st = (await C.manager.get('/api/state')).data; assert.equal(st.products.find(p => p.id === x.keg).stock, 47.5); assert.ok(st.sales.find(s => s.id === r.data.id)); assert.equal(st.moves.find(z => z.ref === r.data.id).qty, -2.5);
  assert.deepEqual(await x.rep(), before);
  await db.end();
});
