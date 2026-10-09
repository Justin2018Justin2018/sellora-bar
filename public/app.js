'use strict';
/* Savanna Lodge POS - browser front end.
   The browser only DISPLAYS data and SENDS commands. Every rule (permissions, stock, money, bookings)
   is enforced by the server in /api. Nothing here is trusted, and no business data is stored in the browser. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KSH = n => 'KSh ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const TZO = 3; // East Africa Time: must match TZ_OFFSET_HOURS on the server
const today = () => new Date(Date.now() + TZO * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const dayOf = ts => new Date(Date.parse(ts) + TZO * 3600e3).toISOString().slice(0, 10);
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const ROLES = ['cashier', 'bartender', 'waiter', 'kitchen', 'receptionist', 'storekeeper', 'manager', 'admin'];
const METHODS = ['Cash', 'M-Pesa', 'Card'];
function newForm() { return { staff: '', table: 'Takeaway', method: 'Cash', cash: '', mpesa: '', bid: '', cust: '', later: false }; }
let S = null, ME = null, AUTH = 'boot', TAB = 'dash', CART = [], ERR = '', R = {}, RF = today(), RT = today(), TOKEN = uid('t'), FORM = newForm(), BUSY = false, LASTERR = '';
const IDEM = {}; const idemFor = k => IDEM[k] || (IDEM[k] = uid('i'));

/* ---------------------------------------------------------------- display mode (Auto / PC / Phone) */
let DM = (() => { try { const v = localStorage.getItem('mjDisplayMode'); return ['auto', 'pc', 'phone'].includes(v) ? v : 'auto'; } catch (e) { return 'auto'; } })();
function dmDetect() { const w = innerWidth; let c = false; try { c = matchMedia('(pointer:coarse)').matches; } catch (e) {} const ss = Math.min(screen.width || w, screen.height || w); return (w < 768 || (c && ss < 600)) ? 'phone' : 'pc'; }
function dmApply() {
  const e = DM === 'auto' ? dmDetect() : DM, r = document.documentElement; r.classList.remove('dm-pc', 'dm-phone'); r.classList.add('dm-' + e); r.dataset.dm = DM;
  let small = false; try { small = Math.min(screen.width || 9999, screen.height || 9999) < 768 && matchMedia('(pointer:coarse)').matches; } catch (x) {}
  document.getElementById('vp').setAttribute('content', (e === 'pc' && DM === 'pc' && small) ? 'width=1280,viewport-fit=cover' : 'width=device-width, initial-scale=1, viewport-fit=cover');
}
function setMode(m) { DM = m; try { localStorage.setItem('mjDisplayMode', m); } catch (e) {} dmApply(); render(); }
function dmSwitch(full) { return `<div class="dm ${full ? 'full' : ''}" role="group" aria-label="Display mode">${[['auto', 'Auto'], ['pc', 'PC'], ['phone', 'Phone']].map(m => `<button aria-pressed="${DM === m[0]}" onclick="setMode('${m[0]}')">${m[1]}</button>`).join('')}</div>`; }
function dmDecorate() { document.querySelectorAll('#app table').forEach(t => { const h = [...(t.querySelector('tr') || { children: [] }).children].map(x => x.textContent.trim()); t.querySelectorAll('tr').forEach(r => [...r.children].forEach((c, i) => { if (c.tagName === 'TD' && h[i]) c.dataset.label = h[i]; })); }); }
function sheet(b) { const w = document.querySelector('.sheetwrap'); if (w) w.classList.toggle('open', b); }
function toggleTheme() { const r = document.documentElement, d = r.dataset.theme === 'dark' || (!r.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches); r.dataset.theme = d ? 'light' : 'dark'; }
addEventListener('resize', () => { if (DM === 'auto') dmApply(); }); dmApply();

/* ---------------------------------------------------------------- server calls */
async function api(method, path, body) {
  let r;
  try { r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-POS': '1' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }); }
  catch (e) { throw new Error('Cannot reach the server. Check the internet connection and try again.'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!j) throw new Error('Unexpected reply from the server (' + r.status + ').');
  if (!j.ok) {
    const e = new Error(j.error || 'Request failed'); e.status = r.status;
    if (r.status === 401 && ME) { ME = null; S = null; CART = []; AUTH = 'login'; ERR = 'Your session ended. Please sign in again.'; e.silent = true; render(); }
    throw e;
  }
  return j.data;
}
async function act(fn, okMsg) { // one action at a time; errors become a visible message
  if (BUSY) return false; BUSY = true; document.body.classList.add('busy');
  try { const r = await fn(); if (okMsg) toast(okMsg); return r === undefined ? true : r; }
  catch (e) { LASTERR = e.message; if (!e.silent) toast(e.message, true); return false; }
  finally { BUSY = false; document.body.classList.remove('busy'); }
}
async function refresh() { S = await api('GET', '/api/state'); ME = S.me; }
const rep = (a, b) => api('GET', '/api/report?from=' + a + '&to=' + b);
async function pre(t) { // reports needed by a tab
  R = {}; if (!can('reports')) return; const d = today();
  if (t === 'dash') { [R.d, R.w, R.m] = await Promise.all([rep(d, d), rep(addDays(d, -6), d), rep(d.slice(0, 8) + '01', d)]); }
  else if (t === 'fin') R.d = await rep(d, d);
  else if (t === 'rep') R.r = await rep(RF, RT);
}
const after = async () => { await refresh(); await pre(TAB); };
async function run(fn, msg) { const ok = await act(async () => { await fn(); await after(); }, msg); render(); return ok; }
async function go(t) { sheet(false); TAB = t; await act(async () => { await after(); }); render(); scrollTo(0, 0); }
function reloadNow() { act(after).then(render); }

/* ---------------------------------------------------------------- small UI helpers */
let toastTimer;
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show ' + (bad ? 'bad' : 'ok'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 9000 : 4500); }
function form(title, fields, okLabel) { // modal dialog; resolves with {key:value} or null when cancelled
  return new Promise(res => {
    const m = document.createElement('div'); m.className = 'modalback';
    m.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>` + fields.map((f, i) => {
      if (f.note) return `<p class="muted">${esc(f.note)}</p>`;
      const id = 'mf' + i, v = f.value == null ? '' : f.value;
      let c;
      if (f.options) c = `<select id="${id}">${f.options.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(v) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
      else c = `<input id="${id}" type="${f.type || 'text'}" ${f.type === 'number' ? 'step="any" min="0" inputmode="decimal"' : ''} value="${esc(v)}" ${f.type === 'password' ? 'autocomplete="off"' : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>`;
      return `<div class="fld"><label for="${id}">${esc(f.label)}</label>${c}</div>`;
    }).join('') + `<p class="bad" id="mfe" role="alert"></p><div class="row"><button class="p" id="mfok">${esc(okLabel || 'Save')}</button><button id="mfno">Cancel</button></div></div>`;
    document.body.appendChild(m);
    const close = v => { document.removeEventListener('keydown', key); m.remove(); res(v); };
    const submit = () => {
      const out = {}; let err = '';
      fields.forEach((f, i) => { if (f.note) return; const el = $('#mf' + i), v = el.value.trim(); out[f.key] = el.value; if (f.required && !v && !err) err = f.label + ' is required.'; });
      if (err) { $('#mfe').textContent = err; return; } close(out);
    };
    const key = e => { if (e.key === 'Escape') close(null); else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); } };
    document.addEventListener('keydown', key); $('#mfok').onclick = submit; $('#mfno').onclick = () => close(null);
    const first = m.querySelector('input,select'); if (first) first.focus();
  });
}
const kpi = (l, v, c) => `<div class="card kpi"><span>${l}</span><b class="${c || ''}">${v}</b></div>`;
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

/* ---------------------------------------------------------------- permissions + data helpers (display only; the server decides) */
const can = p => !!ME && (ME.perms.includes('*') || ME.perms.includes(p));
const prod = id => S.products.find(p => p.id === id);
const live = s => s.status !== 'void' && s.status !== 'cancelled';
const saleOf = id => S.sales.find(s => s.id === id);
const avail = p => p.recipe && p.recipe.length ? Math.floor(Math.min(...p.recipe.map(r => { const i = prod(r.pid); return i ? i.stock / r.qty : 0; })) + 1e-9) : p.stock;
const TABS = [['dash', 'Dashboard', () => true], ['bar', 'Bar POS', () => can('sell')], ['rest', 'Restaurant', () => can('sell')], ['kitchen', 'Kitchen', () => can('kitchen')], ['rooms', 'Rooms', () => can('rooms')], ['stock', 'Stock', () => can('stock')], ['fin', 'Finance', () => can('finance')], ['rep', 'Reports', () => can('reports')], ['users', 'Users', () => ME.role === 'admin']];
const vis = () => TABS.filter(t => t[2]());
const IC = { dash: '📊', bar: '🍺', rest: '🍖', kitchen: '👨‍🍳', rooms: '🛏️', stock: '📦', fin: '💰', rep: '📈', users: '👥' };

/* ---------------------------------------------------------------- shell + login */
function shell(body) {
  return `<header><div><h1>🍽️ Savanna Lodge POS</h1><small>Bar • Restaurant • Lodging</small></div><div class="row" style="align-items:center"><span class="hd-user">${esc(ME.name)} <span class="tag">${esc(ME.role)}</span></span>${dmSwitch(false)}<button onclick="reloadNow()" aria-label="Refresh data" title="Refresh">↻</button><button onclick="changePw()" aria-label="Change my password" title="Change my password">🔑</button><button onclick="toggleTheme()" aria-label="Toggle dark mode">🌓</button><button onclick="doLogout()" aria-label="Log out">Log out</button></div></header>
<nav>${vis().map(t => `<button class="${TAB === t[0] ? 'on' : ''}" onclick="go('${t[0]}')">${t[1]}</button>`).join('')}</nav><main>${body}</main>${bottomNav()}`;
}
function bottomNav() {
  const v = vis(), pref = ['dash', 'bar', 'rest', 'kitchen', 'rooms', 'stock', 'fin', 'rep'], prim = pref.map(k => v.find(t => t[0] === k)).filter(Boolean).slice(0, 5), rest = v.filter(t => !prim.includes(t));
  return `<div class="bnav">${prim.map(t => `<button class="${TAB === t[0] ? 'cur' : ''}" ${TAB === t[0] ? 'aria-current="page"' : ''} onclick="go('${t[0]}')"><span class="ic">${IC[t[0]]}</span>${t[1]}</button>`).join('')}<button onclick="sheet(true)" aria-label="More"><span class="ic">☰</span>More</button></div>
 <div class="sheetwrap"><div class="back" onclick="sheet(false)"></div><div class="panel" role="dialog" aria-label="More"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">More</h2><button onclick="sheet(false)" aria-label="Close">✕</button></div>
 ${rest.length ? `<div class="lbl">Sections</div><div class="mg">${rest.map(t => `<button onclick="go('${t[0]}')">${IC[t[0]]} ${t[1]}</button>`).join('')}</div>` : ''}
 <div class="lbl">Display mode</div>${dmSwitch(true)}<div class="lbl">Account</div><div class="mg"><button onclick="toggleTheme()">🌓 Dark / light</button><button onclick="sheet(false);changePw()">🔑 Password</button><button class="d" onclick="doLogout()">🚪 Log out</button></div><p class="muted">${esc(ME.name)} • ${esc(ME.role)}</p></div></div>`;
}
function render() {
  const A = $('#app');
  if (AUTH === 'boot') { A.innerHTML = '<div id="login" class="card"><p class="muted">Loading…</p></div>'; return; }
  if (AUTH === 'setup') {
    A.innerHTML = `<div id="login" class="card"><h2>🍽️ Savanna Lodge POS</h2><p>Welcome. Create the owner account to get started. This screen only appears once.</p><form onsubmit="doSetup(event)">
 <p><label for="su">Username</label><br><input id="su" autocomplete="username" style="width:100%" required></p><p><label for="sn">Full name</label><br><input id="sn" style="width:100%" required></p>
 <p><label for="sp1">Password (8+ characters, not easy to guess)</label><br><input id="sp1" type="password" autocomplete="new-password" style="width:100%" required></p><p><label for="sp2">Repeat password</label><br><input id="sp2" type="password" autocomplete="new-password" style="width:100%" required></p>
 <button class="p" type="submit">Create owner account</button></form><p class="muted" id="le">${esc(ERR)}</p></div>`; return;
  }
  if (!ME) {
    A.innerHTML = `<div id="login" class="card"><h2>🍽️ Savanna Lodge POS</h2><form onsubmit="doLogin(event)"><p><label for="lu">Username</label><br><input id="lu" autocomplete="username" autocapitalize="none" style="width:100%" required></p>
 <p><label for="lp">Password</label><br><input id="lp" type="password" autocomplete="current-password" style="width:100%" required></p><button class="p" type="submit">Sign in</button></form>
 <p class="bad" id="le" role="alert">${esc(ERR)}</p><div class="lbl" style="margin:14px 0 6px;font-size:11px;font-weight:800;color:var(--mu)">DISPLAY MODE</div>${dmSwitch(true)}</div>`; return;
  }
  if (!vis().some(t => t[0] === TAB)) TAB = 'dash';
  const V = { dash: vDash, bar: () => vPos('bar'), rest: () => vPos('rest'), kitchen: vKitchen, rooms: vRooms, stock: vStock, fin: vFin, rep: vRep, users: vUsers };
  A.innerHTML = shell(V[TAB]()); dmDecorate();
}
async function doLogin(e) {
  e.preventDefault(); const un = $('#lu').value.trim(), pw = $('#lp').value; ERR = '';
  const ok = await act(async () => { await api('POST', '/api/login', { username: un, password: pw }); TAB = 'dash'; await after(); });
  if (!ok) { ERR = LASTERR; ME = null; }
  render();
}
async function doSetup(e) {
  e.preventDefault(); const un = $('#su').value.trim(), nm = $('#sn').value.trim(), p1 = $('#sp1').value, p2 = $('#sp2').value;
  if (p1 !== p2) { $('#le').textContent = 'The two passwords do not match.'; return; }
  const ok = await act(async () => { await api('POST', '/api/setup', { username: un, name: nm, password: p1 }); await api('POST', '/api/login', { username: un, password: p1 }); AUTH = 'app'; TAB = 'dash'; await after(); });
  if (!ok) { ERR = LASTERR; ME = null; AUTH = 'setup'; }
  render();
}
async function doLogout() { try { await api('POST', '/api/logout'); } catch (e) {} ME = null; S = null; CART = []; FORM = newForm(); ERR = ''; AUTH = 'login'; sheet(false); render(); }
async function changePw() {
  const v = await form('Change my password', [{ key: 'cur', label: 'Current password', type: 'password', required: true }, { key: 'p1', label: 'New password (8+ characters)', type: 'password', required: true }, { key: 'p2', label: 'Repeat new password', type: 'password', required: true }]);
  if (!v) return; if (v.p1 !== v.p2) return toast('The two new passwords do not match.', true);
  await act(async () => { await api('POST', '/api/me/password', { current: v.cur, password: v.p1 }); }, 'Password changed. Other devices were signed out.');
}

/* ---------------------------------------------------------------- dashboard */
function vShift() {
  const c = S.shifts.find(x => x.user === ME.id && !x.close);
  return `<div class="card"><h3>My shift</h3>${c ? `<p>Open since ${new Date(c.open).toLocaleString()} • float ${KSH(c.float)}</p><button class="p" onclick="closeShift()">Close shift &amp; reconcile</button>` : `<button class="p" onclick="openShift()">Open shift</button>`}
 <div class="tw"><table><tr><th>Cashier</th><th>Closed</th><th>Expected</th><th>Counted</th><th>Variance</th></tr>${S.shifts.filter(x => x.close).slice(0, 6).map(x => `<tr><td>${esc(x.userName)}</td><td>${new Date(x.close).toLocaleString()}</td><td>${KSH(x.expected)}</td><td>${KSH(x.counted)}</td><td class="${Math.abs(x.counted - x.expected) > 0.009 ? 'bad' : 'ok'}">${KSH(x.counted - x.expected)}</td></tr>`).join('')}</table></div></div>`;
}
function vDash() {
  const d = R.d, w = R.w, m = R.m, best = {};
  S.sales.filter(live).forEach(s => s.items.forEach(i => best[i.name] = (best[i.name] || 0) + i.qty));
  const top = Object.entries(best).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rs = ['vacant', 'occupied', 'dirty', 'maintenance'].map(k => [k, S.rooms.filter(r => r.status === k).length]); rs.splice(1, 0, ['reserved', S.bookings.filter(b => b.status === 'reserved').length]);
  const low = S.products.filter(p => p.active && p.stock <= p.reorder);
  return `${d ? `<div class="grid">${kpi("Today's revenue", KSH(d.rv))}${kpi('Bar', KSH(d.rev.bar))}${kpi('Restaurant', KSH(d.rev.rest))}${kpi('Lodging', KSH(d.rev.lodging))}${kpi('Expenses', KSH(d.exp))}${kpi('Gross profit', KSH(d.gp), d.gp < 0 ? 'bad' : 'ok')}${kpi('Net profit', KSH(d.np), d.np < 0 ? 'bad' : 'ok')}${kpi('Outstanding bills', KSH(d.out), d.out ? 'wn' : '')}</div>
 <div class="card"><h3>Payments received today</h3>${Object.entries(d.pm).map(([k, v]) => `<span class="tag">${esc(k)}: ${KSH(v)}</span> `).join('') || '<span class="muted">None yet.</span>'}</div>` : ''}
 <div class="grid"><div class="card"><h3>Rooms</h3>${rs.map(r => `<div>${r[0]}: <b>${r[1]}</b></div>`).join('') || '-'}</div>
 ${w && m ? `<div class="card"><h3>Performance</h3><div>Week: ${KSH(w.rv)} (net ${KSH(w.np)})</div><div>Month: ${KSH(m.rv)} (net ${KSH(m.np)})</div></div>` : ''}
 <div class="card"><h3>Best sellers</h3>${top.map(t => `<div>${esc(t[0])} × ${t[1]}</div>`).join('') || '<span class="muted">No sales yet.</span>'}</div>
 <div class="card"><h3>Low stock</h3>${low.slice(0, 12).map(p => `<div class="wn">${esc(p.name)}: ${p.stock}</div>`).join('') || '<span class="muted">All good.</span>'}${low.length > 12 ? `<div class="muted">+ ${low.length - 12} more in Stock</div>` : ''}</div></div>
 ${can('shift') ? vShift() : ''}
 <div class="card"><h3>Recent transactions</h3><div class="tw"><table><tr><th>Time</th><th>Ref</th><th>Dept</th><th>Sold by</th><th>Total</th><th>Status</th></tr>${S.sales.slice(0, 8).map(s => `<tr><td>${new Date(s.ts).toLocaleTimeString()}</td><td>${esc(s.id)}</td><td>${s.dept}</td><td>${esc(s.staffName)}</td><td>${KSH(s.total)}</td><td>${esc(s.status)}/${esc(s.pay)}</td></tr>`).join('')}</table></div></div>`;
}

/* ---------------------------------------------------------------- bar + restaurant POS */
function vPos(dept) {
  const ps = S.products.filter(p => p.dept === dept && p.active), occ = S.bookings.filter(b => b.status === 'in'), tot = CART.reduce((a, c) => a + c.qty * prod(c.pid).price, 0);
  const orders = S.sales.filter(s => s.dept === dept && live(s) && s.balance > 0), F = FORM, off = p => avail(p) <= 0 || !(p.price > 0);
  const n = ps.filter(off).length;
  return `<div class="two"><div class="card"><h3>${dept === 'bar' ? '🍺 Bar' : '🍖 Restaurant'} menu</h3>${n ? `<div class="warn" style="margin-bottom:8px">${n} of ${ps.length} items can't be sold yet (no price or no stock). Greyed items explain why when tapped${can('price') || can('stock') ? ' — set them up in <b>Stock</b>' : ''}.</div>` : ''}
 <input type="search" placeholder="Search items…" aria-label="Search items" oninput="fprod(this.value)" style="width:100%;margin-bottom:8px"><div class="prod">${ps.map(p => `<button data-n="${esc(p.name.toLowerCase())}" onclick="addC('${p.id}')" style="${off(p) ? 'opacity:.55' : ''}"><b>${esc(p.name)}</b><br>${p.price > 0 ? KSH(p.price) : '<span class="wn">set price</span>'}<br><span class="muted">${p.recipe ? 'can make' : 'stock'} ${avail(p)}</span></button>`).join('')}</div></div>
 <div class="card"><h3>Current order</h3>${CART.map((c, i) => `<div class="row"><span style="flex:1">${esc(prod(c.pid).name)}</span><button onclick="qty(${i},-1)" aria-label="Less">−</button><b>${c.qty}</b><button onclick="qty(${i},1)" aria-label="More">+</button></div>`).join('') || '<p class="muted">Tap items to add.</p>'}<h2>${KSH(tot)}</h2>
 <div class="row"><div><label for="f_staff">Sale Done By / Salesperson*</label><select id="f_staff" onchange="FORM.staff=this.value"><option value="">Select Staff Member</option>${S.users.filter(u => u.active && u.role !== 'kitchen').map(u => `<option value="${u.id}" ${F.staff === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
 ${dept === 'rest' ? `<div><label for="f_table">Table</label><select id="f_table" onchange="FORM.table=this.value"><option>Takeaway</option>${S.tables.map(t => `<option ${F.table === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>` : ''}
 <div><label for="f_m">Payment</label><select id="f_m" onchange="FORM.method=this.value;$('#sp').style.display=this.value==='Split'?'flex':'none'">${['Cash', 'M-Pesa', 'Card', 'Split', 'Room', 'Credit'].map(x => `<option ${F.method === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
 <div class="row" id="sp" style="display:${F.method === 'Split' ? 'flex' : 'none'}"><div><label for="f_c">Cash</label><input id="f_c" type="number" min="0" value="${esc(F.cash)}" oninput="FORM.cash=this.value" style="width:100px"></div><div><label for="f_p">M-Pesa</label><input id="f_p" type="number" min="0" value="${esc(F.mpesa)}" oninput="FORM.mpesa=this.value" style="width:100px"></div></div>
 <div class="row"><div><label for="f_b">Room (if Room)</label><select id="f_b" onchange="FORM.bid=this.value">${occ.map(b => `<option value="${b.id}" ${F.bid === b.id ? 'selected' : ''}>Room ${esc(b.room)} — ${esc(b.guest)}</option>`).join('') || '<option value="">No occupied rooms</option>'}</select></div><div><label for="f_cu">Customer (credit)</label><input id="f_cu" value="${esc(F.cust)}" oninput="FORM.cust=this.value"></div></div>
 ${dept === 'rest' ? `<label><input type="checkbox" id="f_later" ${F.later ? 'checked' : ''} onchange="FORM.later=this.checked"> Pay later (open bill)</label><br>` : ''}<div class="stick"><button class="p" onclick="submitSale('${dept}')">Complete Sale</button> <button onclick="CART=[];FORM=newForm();render()">Clear</button></div></div></div>
 ${orders.length ? `<div class="card"><h3>Open bills</h3>${orders.map(o => `<div class="row"><span style="flex:1">${esc(o.id)} ${esc(o.table)} ${o.pay === 'credit' ? '(credit: ' + esc(o.cust) + ')' : ''} — balance ${KSH(o.balance)}</span><button onclick="settle('${o.id}','Cash')">Cash</button><button onclick="settle('${o.id}','M-Pesa')">M-Pesa</button><button onclick="settle('${o.id}','Card')">Card</button><button class="d" onclick="voidSale('${o.id}')">Cancel</button></div>`).join('')}</div>` : ''}
 <div class="card"><h3>Recent ${dept} sales</h3><div class="tw"><table><tr><th>Ref</th><th>Sold by</th><th>Total</th><th>Status</th><th></th></tr>${S.sales.filter(s => s.dept === dept).slice(0, 8).map(s => `<tr><td>${esc(s.id)}</td><td>${esc(s.staffName)}</td><td>${KSH(s.total)}</td><td>${esc(s.status)}/${esc(s.pay)}</td><td><button onclick="receipt('${s.id}')">Receipt</button> ${live(s) ? `<button class="d" onclick="voidSale('${s.id}')">Void</button>` : ''}</td></tr>`).join('')}</table></div></div>`;
}
function fprod(q) { q = q.toLowerCase(); document.querySelectorAll('.prod button').forEach(b => b.style.display = b.dataset.n.includes(q) ? '' : 'none'); }
function addC(pid) {
  const p = prod(pid);
  if (!(p.price > 0)) return toast(p.name + ' has no selling price yet. ' + (can('price') ? 'Set it in Stock → Edit.' : 'Ask the owner or a manager to set it.'), true);
  if (avail(p) <= 0) return toast(p.name + ' is out of stock. ' + (can('stock') ? 'Use Stock → Receive or Adjust.' : 'Ask the storekeeper.'), true);
  const c = CART.find(x => x.pid === pid); if (c) { if (c.qty < avail(p)) c.qty++; } else CART.push({ pid, qty: 1 }); render();
}
function qty(i, d) { CART[i].qty += d; if (CART[i].qty <= 0) CART.splice(i, 1); else if (CART[i].qty > avail(prod(CART[i].pid))) CART[i].qty = avail(prod(CART[i].pid)); render(); }
async function submitSale(dept) {
  if (!CART.length) return toast('Add items first.', true);
  if (!FORM.staff) return toast('Please select who did this sale before recording the transaction.', true);
  const body = { token: TOKEN, dept, items: CART.map(c => ({ pid: c.pid, qty: c.qty })), staffId: FORM.staff, method: FORM.method, table: dept === 'rest' ? FORM.table : '', customer: FORM.cust, bookingId: FORM.bid || ($('#f_b') ? $('#f_b').value : ''), later: dept === 'rest' && !!FORM.later && METHODS.includes(FORM.method), cash: Number(FORM.cash || 0), mpesa: Number(FORM.mpesa || 0) };
  let id = null;
  const ok = await act(async () => { const r = await api('POST', '/api/sale', body); id = r.id; await after(); });
  if (ok) { CART = []; FORM = newForm(); TOKEN = uid('t'); render(); receipt(id); } else if (ME) render();
}
function receipt(id) { // printed through a hidden frame: no pop-up blocker problems
  const s = saleOf(id); if (!s) return;
  const html = `<pre style="font:13px monospace">SAVANNA LODGE\n${s.dept === 'bar' ? 'BAR' : 'RESTAURANT'} RECEIPT\n${esc(s.id)}\n${new Date(s.ts).toLocaleString()}\nSold By: ${esc(s.staffName)}${s.table ? '\nTable: ' + esc(s.table) : ''}\n------------------------\n${s.items.map(i => esc(i.name) + ' x' + i.qty + '  ' + (i.qty * i.price)).join('\n')}\n------------------------\nTOTAL ${KSH(s.total)}\nPayment: ${esc(s.pay)}${live(s) ? '' : '\nSTATUS: ' + s.status.toUpperCase()}</pre>`;
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'; document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write('<!doctype html><title>Receipt</title>' + html); f.contentDocument.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { toast('Could not open the print dialog.', true); } setTimeout(() => f.remove(), 60000); }, 150);
}
async function settle(id, method) {
  const s = saleOf(id); if (!s) return;
  const v = await form('Receive payment (' + method + ')', [{ note: s.id + ' — balance ' + KSH(s.balance) }, { key: 'amount', label: 'Amount (KSh)', type: 'number', value: s.balance, required: true }], 'Record payment');
  if (!v) return; const amt = Number(v.amount); if (!(amt > 0) || amt > s.balance + 0.009) return toast('Invalid amount.', true);
  const k = 'settle|' + id + '|' + method + '|' + amt;
  if (await run(() => api('POST', '/api/settle', { saleId: id, amount: amt, method, idem: idemFor(k) }), 'Payment recorded')) delete IDEM[k];
}
async function voidSale(id) {
  const s = saleOf(id); if (!s || !live(s)) return; const self = can('void');
  const fields = [{ note: s.id + ' — ' + KSH(s.total) + (s.dept === 'rest' && ['preparing', 'ready', 'served'].includes(s.status) ? '. Food was already prepared, so ingredients will NOT go back into stock.' : '. Stock will be returned and payments refunded.') }, { key: 'reason', label: 'Reason (required)', required: true }];
  if (!self) fields.push({ note: 'Your role cannot void sales. A manager must approve with their own login.' }, { key: 'au', label: 'Manager username', required: true }, { key: 'ap', label: 'Manager password', type: 'password', required: true });
  const v = await form('Void / cancel sale', fields, 'Void sale'); if (!v) return;
  const body = { saleId: id, reason: v.reason }; if (!self) body.approver = { username: v.au, password: v.ap };
  await run(() => api('POST', '/api/void', body), 'Sale voided');
}

/* ---------------------------------------------------------------- kitchen */
function vKitchen() {
  const o = S.sales.filter(s => s.dept === 'rest' && live(s) && s.status !== 'served').slice().reverse(), nx = { pending: 'preparing', preparing: 'ready', ready: 'served' };
  return `<div class="card"><h3>👨‍🍳 Kitchen queue</h3><p class="muted">Refreshes by itself every 15 seconds.</p>${o.map(s => `<div class="card"><b>${esc(s.id)}</b> ${esc(s.table)} <span class="tag">${esc(s.status)}</span><ul>${s.items.map(i => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>${nx[s.status] ? `<button class="p" onclick="kstep('${s.id}','${nx[s.status]}')">Mark ${nx[s.status]}</button>` : ''}</div>`).join('') || '<p class="muted">No open orders.</p>'}</div>`;
}
const kstep = (id, st) => run(() => api('POST', '/api/kitchen', { saleId: id, status: st }));
setInterval(() => { if (ME && TAB === 'kitchen' && !BUSY && !document.querySelector('.modalback')) refresh().then(() => { if (ME && TAB === 'kitchen' && !document.querySelector('.modalback')) render(); }).catch(() => {}); }, 15000);

/* ---------------------------------------------------------------- rooms */
function vRooms() {
  const t = today();
  return `<div class="grid">${S.rooms.map(r => `<div class="card"><b>Room ${esc(r.no)}</b> <span class="muted">${esc(r.type)} • ${KSH(r.rate)}</span><br><span class="tag">${r.status}</span>${r.status === 'dirty' ? ` <button data-no="${esc(r.no)}" onclick="rstat(this.dataset.no,'vacant')">Mark clean</button>` : ''}${r.status === 'vacant' ? ` <button data-no="${esc(r.no)}" onclick="rstat(this.dataset.no,'maintenance')">Maintenance</button>` : ''}${r.status === 'maintenance' ? ` <button data-no="${esc(r.no)}" onclick="rstat(this.dataset.no,'vacant')">Available</button>` : ''}</div>`).join('') || '<div class="card muted">No rooms yet.</div>'}</div>
 ${can('price') ? `<details class="card"><summary><b>Add a room</b></summary><div class="row"><div><label for="nr_no">Room number</label><input id="nr_no"></div><div><label for="nr_ty">Type</label><input id="nr_ty" placeholder="Single, Double, Suite"></div><div><label for="nr_ra">Rate per night (KSh)</label><input id="nr_ra" type="number" min="0"></div><button class="p" onclick="roomCreate()">Add room</button></div></details>` : ''}
 <div class="card"><h3>New reservation</h3><div class="row"><div><label for="r_room">Room</label><select id="r_room">${S.rooms.map(r => `<option>${esc(r.no)}</option>`).join('')}</select></div><div><label for="r_g">Guest</label><input id="r_g"></div><div><label for="r_p">Phone</label><input id="r_p"></div><div><label for="r_in">Arrival</label><input type="date" id="r_in" value="${t}"></div><div><label for="r_out">Departure</label><input type="date" id="r_out"></div><button class="p" onclick="reserve()">Reserve</button></div></div>
 <div class="card"><h3>Bookings &amp; guest folios</h3>${S.bookings.slice().reverse().map(b => {
    const f = b.folio, ch = S.charges.filter(c => c.bid === b.id), est = b.status === 'in' && f.est ? f.est : 0, bal = f.bal + est;
    return `<div class="card"><b>Room ${esc(b.room)} — ${esc(b.guest)}</b> <span class="tag">${b.status}</span> <span class="muted">${esc(b.in)} → ${esc(b.out)}${b.phone ? ' • ' + esc(b.phone) : ''}</span>
 <div class="tw"><table>${ch.map(c => `<tr><td>${esc(c.desc)}</td><td>${KSH(c.amount)}</td></tr>`).join('')}${est ? `<tr><td>Accommodation so far (${f.estNights} night(s), estimate)</td><td>${KSH(est)}</td></tr>` : ''}<tr><td>Payments received</td><td>${KSH(f.pa)}</td></tr><tr><th>Balance</th><th class="${bal > 0 ? 'bad' : 'ok'}">${KSH(bal)}</th></tr></table></div>
 ${b.status === 'reserved' ? `<button class="p" onclick="checkin('${b.id}')">Check in</button> ` : ''}${b.status === 'in' ? `<button class="p" onclick="checkout('${b.id}')">Check out</button> ` : ''}${['reserved', 'in', 'out'].includes(b.status) && can('pay') && !(b.status === 'out' && f.bal <= 0) ? `<button onclick="payFolio('${b.id}')">${b.status === 'reserved' ? 'Take deposit' : 'Take payment'}</button> ` : ''}${['reserved', 'in'].includes(b.status) ? `<button onclick="extend('${b.id}','${esc(b.out)}')">Change departure</button> ` : ''}${b.status === 'reserved' ? `<button class="d" onclick="cancelBooking('${b.id}')">Cancel booking</button>` : ''}</div>`;
  }).join('') || '<p class="muted">No bookings yet.</p>'}</div>`;
}
const rstat = (no, st) => run(() => api('POST', '/api/room/status', { no, status: st }));
function roomCreate() { const no = $('#nr_no').value.trim(), ty = $('#nr_ty').value.trim(), ra = $('#nr_ra').value; if (!no || !ty || !(Number(ra) > 0)) return toast('Room number, type and a rate above zero are required.', true); run(() => api('POST', '/api/room/create', { no, type: ty, rate: Number(ra) }), 'Room added'); }
function reserve() { const b = { room: $('#r_room').value, guest: $('#r_g').value.trim(), phone: $('#r_p').value.trim(), in: $('#r_in').value, out: $('#r_out').value }; if (!b.guest || !b.in || !b.out || b.out <= b.in) return toast('Guest name and valid dates (departure after arrival) are required.', true); run(() => api('POST', '/api/room/reserve', b), 'Reserved'); }
const checkin = id => run(() => api('POST', '/api/room/checkin', { bookingId: id }), 'Checked in');
async function checkout(id) {
  let debt = false;
  const ok = await act(async () => {
    try { await api('POST', '/api/room/checkout', { bookingId: id }); }
    catch (e) {
      if (e.status === 409 && /Outstanding/.test(e.message) && can('approve') && confirm(e.message + '\n\nLeave this balance as a debt and check the guest out anyway?')) { debt = true; await api('POST', '/api/room/checkout', { bookingId: id, allowDebt: true }); }
      else throw e;
    }
    await after();
  }, 'Checked out' + (debt ? ' (balance left as debt)' : ''));
  render(); return ok;
}
async function payFolio(id) {
  const b = S.bookings.find(x => x.id === id), est = b.status === 'in' && b.folio.est ? b.folio.est : 0, due = Math.max(0, b.folio.bal + est);
  const v = await form('Take payment — Room ' + b.room + ' (' + b.guest + ')', [{ note: 'Balance now: ' + KSH(b.folio.bal + est) }, { key: 'amount', label: 'Amount (KSh)', type: 'number', value: due || '', required: true }, { key: 'method', label: 'Method', options: METHODS.map(m => [m, m]) }], 'Record payment');
  if (!v) return; const amt = Number(v.amount); if (!(amt > 0)) return toast('Amount must be above zero.', true);
  const k = 'folio|' + id + '|' + v.method + '|' + amt;
  if (await run(() => api('POST', '/api/room/pay', { bookingId: id, amount: amt, method: v.method, idem: idemFor(k) }), 'Payment recorded')) delete IDEM[k];
}
async function extend(id, cur) { const v = await form('Change departure date', [{ key: 'out', label: 'New departure date', type: 'date', value: cur, required: true }]); if (v) run(() => api('POST', '/api/room/extend', { bookingId: id, out: v.out }), 'Departure changed'); }
async function cancelBooking(id) { const v = await form('Cancel booking', [{ note: 'Any deposit taken will be refunded.' }, { key: 'reason', label: 'Reason (required)', required: true }], 'Cancel booking'); if (v) run(() => api('POST', '/api/room/cancel', { bookingId: id, reason: v.reason }), 'Booking cancelled'); }

/* ---------------------------------------------------------------- stock */
function vStock() {
  const items = S.products.filter(p => p.active || p.stock), order = ['Spirits', 'Beer', 'Soft', 'Food', 'Drinks', 'Ingredient'];
  const cats = [...new Set(items.map(p => p.cat || 'Uncategorised'))].sort((x, y) => { const i = order.indexOf(x), j = order.indexOf(y); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || x.localeCompare(y); });
  const row = p => `<tr><td>${esc(p.name)}${p.active ? '' : ' <span class="muted">(retired)</span>'}${p.recipe ? ' <span class="tag">recipe</span>' : ''}</td><td>${p.dept}</td><td class="${p.stock <= p.reorder ? 'wn' : ''}">${p.stock}</td><td>${KSH(p.cost)}</td><td>${p.price > 0 ? KSH(p.price) : '<span class="wn">not set</span>'}</td><td>${can('price') ? `<button onclick="editProd('${p.id}')">Edit</button> ` : ''}${can('stock') ? `<button onclick="recv('${p.id}')">Receive</button> <button onclick="adj('${p.id}')">Adjust</button> ` : ''}${can('price') && p.dept === 'rest' ? `<button onclick="recipe('${p.id}')">Recipe</button>` : ''}</td></tr>`;
  return `<div class="card"><h3>Stock register</h3><div class="muted">Grouped by category — tap a heading to collapse it.</div>${can('price') ? '<p><button class="p" onclick="newItem()">Add item</button></p>' : ''}${items.length ? '' : `<p>No items yet.${ME.role === 'admin' ? ' Add items here, or load the starter menu from the Users tab.' : ''}</p>`}</div>`
    + cats.map(c => { const L = items.filter(p => (p.cat || 'Uncategorised') === c), low = L.filter(p => p.stock <= p.reorder).length;
      return `<details open class="card"><summary><b>${esc(c)}</b> <span class="tag">${L.length} items</span>${low ? ` <span class="tag wn">${low} low</span>` : ''}</summary><div class="tw"><table><tr><th>Item</th><th>Dept</th><th>Stock</th><th>Cost</th><th>Price</th><th></th></tr>${L.map(row).join('')}</table></div></details>`; }).join('')
    + `<div class="card"><h3>Price &amp; item change history</h3><div class="tw"><table><tr><th>When</th><th>Who</th><th>Item</th><th>Change</th><th>Reason</th></tr>${S.priceLog.slice(0, 30).map(h => `<tr><td>${new Date(h.ts).toLocaleString()}</td><td>${esc(h.user)}</td><td>${esc(h.item)}</td><td>${h.changes.map(c => esc(c.field) + ': ' + esc(c.from) + ' → ' + esc(c.to)).join('<br>')}</td><td>${esc(h.reason)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No changes yet.</td></tr>'}</table></div></div>
 <div class="card"><h3>Movement history</h3><div class="tw"><table><tr><th>Time</th><th>Item</th><th>Qty</th><th>Reason</th><th>User</th></tr>${S.moves.slice(0, 25).map(m => `<tr><td>${new Date(m.ts).toLocaleString()}</td><td>${esc((prod(m.pid) || {}).name || m.pid)}</td><td>${m.qty}</td><td>${esc(m.reason)}</td><td>${esc(m.user)}</td></tr>`).join('')}</table></div></div>`;
}
async function newItem() {
  const v = await form('Add item', [{ key: 'name', label: 'Name', required: true }, { key: 'dept', label: 'Where it is sold', options: [['bar', 'Bar'], ['rest', 'Restaurant'], ['store', 'Store only (ingredient)']] }, { key: 'cat', label: 'Category (e.g. Beer, Spirits, Soft, Food, Ingredient)', required: true }, { key: 'price', label: 'Selling price (KSh)', type: 'number', value: 0 }, { key: 'cost', label: 'Buying cost (KSh)', type: 'number', value: 0 }, { key: 'reorder', label: 'Reorder level', type: 'number', value: 5 }]);
  if (v) run(() => api('POST', '/api/product/create', { name: v.name, dept: v.dept, cat: v.cat, price: Number(v.price || 0), cost: Number(v.cost || 0), reorder: Number(v.reorder || 0) }), 'Item added');
}
async function editProd(id) {
  const p = prod(id);
  const v = await form('Edit: ' + p.name, [{ key: 'price', label: 'Selling price (KSh)', type: 'number', value: p.price, required: true }, { key: 'cost', label: 'Buying cost (KSh)', type: 'number', value: p.cost, required: true }, { key: 'reorder', label: 'Reorder level', type: 'number', value: p.reorder, required: true }, { key: 'cat', label: 'Category', value: p.cat, required: true }, { key: 'reason', label: 'Reason for change (required for price/cost)' }, { key: 'pw', label: 'Confirm with YOUR password (' + ME.name + ')', type: 'password', required: true }, { note: 'Every change is recorded with your name, the time, old and new values and your reason. It cannot be deleted.' }], 'Save change');
  if (!v) return; const pr = Number(v.price), co = Number(v.cost);
  if ((pr !== p.price || co !== p.cost) && !v.reason.trim()) return toast('Please give a reason for the price/cost change.', true);
  if ((pr !== p.price || co !== p.cost) && pr > 0 && co > pr && !confirm('Cost is higher than price — save anyway?')) return;
  run(() => api('POST', '/api/product/edit', { id, price: pr, cost: co, reorder: Number(v.reorder), cat: v.cat, reason: v.reason, password: v.pw }), 'Saved');
}
async function recv(id) {
  const p = prod(id), v = await form('Receive stock: ' + p.name, [{ key: 'qty', label: 'Quantity received', type: 'number', required: true }, { key: 'cost', label: 'Unit purchase cost (KSh)', type: 'number', value: p.cost, required: true }], 'Receive');
  if (v && Number(v.qty) > 0) run(() => api('POST', '/api/stock/receive', { pid: id, qty: Number(v.qty), cost: Number(v.cost) }), 'Stock received'); else if (v) toast('Quantity must be above zero.', true);
}
async function adj(id) {
  const p = prod(id), v = await form('Adjust stock: ' + p.name, [{ note: 'System shows ' + p.stock + '. Count what is physically on the shelf.' }, { key: 'counted', label: 'Counted quantity', type: 'number', required: true }, { key: 'kind', label: 'Type', options: [['count', 'Stock-take correction'], ['waste', 'Wastage / breakage']] }, { key: 'reason', label: 'Reason (required)', required: true }], 'Save count');
  if (v) run(() => api('POST', '/api/stock/adjust', { pid: id, counted: Number(v.counted), wastage: v.kind === 'waste', reason: v.reason }), 'Stock adjusted');
}
async function recipe(id) {
  const p = prod(id), ings = S.products.filter(x => x.id !== id && x.dept === 'store'), cur = p.recipe || [], N = 5, f = [{ note: 'What one ' + p.name + ' uses from the store. Leave unused rows empty. Selling it will take these from stock instead.' }];
  if (!ings.length) return toast('Add ingredients first (an item with "Store only" selected).', true);
  for (let i = 0; i < N; i++) { f.push({ key: 'i' + i, label: 'Ingredient ' + (i + 1), options: [['', '—']].concat(ings.map(x => [x.id, x.name])), value: cur[i] ? cur[i].pid : '' }, { key: 'q' + i, label: 'Quantity ' + (i + 1), type: 'number', value: cur[i] ? cur[i].qty : '' }); }
  const v = await form('Recipe: ' + p.name, f); if (!v) return; const list = [];
  for (let i = 0; i < N; i++) if (v['i' + i]) { const q = Number(v['q' + i]); if (!(q > 0)) return toast('Give a quantity for each ingredient chosen.', true); list.push({ pid: v['i' + i], qty: q }); }
  run(() => api('POST', '/api/product/recipe', { id, ingredients: list }), 'Recipe saved');
}

/* ---------------------------------------------------------------- finance */
function vFin() {
  const d = R.d;
  return `${d ? `<div class="grid">${kpi('Gross profit today', KSH(d.gp))}${kpi('Expenses today', KSH(d.exp))}${kpi('Net profit today', KSH(d.np), d.np < 0 ? 'bad' : 'ok')}</div>
 <div class="card"><h3>Daily cash-up</h3>${METHODS.map(m => `<div>${m}: <b>${KSH(d.pm[m] || 0)}</b></div>`).join('')}<p class="muted">Money received today, after refunds. Room-account sales only count once the guest pays the folio.</p></div>` : ''}
 ${can('shift') ? vShift() : ''}<div class="card"><h3>Add expense</h3><div class="row"><div><label for="e_c">Category</label><select id="e_c"><option>Utilities</option><option>Salaries</option><option>Supplies</option><option>Repairs</option><option>Other</option></select></div><div><label for="e_d">Description / ref</label><input id="e_d"></div><div><label for="e_a">Amount</label><input id="e_a" type="number" min="0"></div><button class="p" onclick="addExp()">Save</button></div></div>
 <div class="card"><h3>Expenses</h3><div class="tw"><table><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>By</th></tr>${S.expenses.slice(0, 100).map(e => `<tr><td>${dayOf(e.ts)}</td><td>${esc(e.cat)}</td><td>${esc(e.desc)}</td><td>${KSH(e.amount)}</td><td>${esc(e.user)}</td></tr>`).join('')}</table></div></div>`;
}
function addExp() { const a = Number($('#e_a').value), d = $('#e_d').value.trim(); if (!(a > 0) || !d) return toast('Description and an amount above zero are required.', true); run(() => api('POST', '/api/expense', { cat: $('#e_c').value, desc: d, amount: a }), 'Expense saved'); }
const openShift = async () => { const v = await form('Open shift', [{ key: 'float', label: 'Opening cash float (KSh)', type: 'number', value: 0, required: true }], 'Open shift'); if (v) run(() => api('POST', '/api/shift/open', { float: Number(v.float) }), 'Shift opened'); };
async function closeShift() {
  const v = await form('Close shift', [{ note: 'Count the cash drawer. The system works out what it should hold.' }, { key: 'counted', label: 'Cash counted (KSh)', type: 'number', required: true }], 'Close shift'); if (!v) return;
  let r; const ok = await act(async () => { r = await api('POST', '/api/shift/close', { counted: Number(v.counted) }); await after(); });
  render(); if (ok && r) alert('Shift closed.\nExpected: ' + KSH(r.expected) + '\nCounted: ' + KSH(r.counted) + '\nVariance: ' + KSH(r.variance));
}

/* ---------------------------------------------------------------- reports */
function vRep() {
  const d = R.r; if (!d) return '<div class="card muted">No report available.</div>';
  return `<div class="card row"><div><label for="rf">From</label><input type="date" id="rf" value="${RF}"></div><div><label for="rt">To</label><input type="date" id="rt" value="${RT}"></div><button class="p" onclick="applyRange()">Apply</button><button onclick="csv()">Export sales CSV</button><button onclick="window.print()">Print</button></div>
 <div class="grid">${kpi('Revenue', KSH(d.rv))}${kpi('Gross profit', KSH(d.gp))}${kpi('Expenses', KSH(d.exp))}${kpi('Net profit', KSH(d.np), d.np < 0 ? 'bad' : 'ok')}${kpi('Outstanding', KSH(d.out), d.out ? 'wn' : '')}${kpi('Deposits held', KSH(d.deposits))}${kpi('Stock value (at cost)', KSH(d.stockValue))}</div>
 <div class="card"><h3>By department</h3>Bar ${KSH(d.rev.bar)} • Restaurant ${KSH(d.rev.rest)} • Lodging ${KSH(d.rev.lodging)}<h3>By salesperson</h3>${Object.entries(d.bySalesperson).map(([k, v]) => `<div>${esc(k)}: ${KSH(v)}</div>`).join('') || '-'}<h3>By payment method</h3>${Object.entries(d.pm).map(([k, v]) => `<div>${esc(k)}: ${KSH(v)}</div>`).join('') || '-'}<h3>Outstanding</h3><div>Open bills and credit: ${KSH(d.outSales)}</div><div>Guest folios: ${KSH(d.outBookings)}</div></div>
 <div class="card"><h3>Audit log</h3><div class="tw"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${S.audit.slice(0, 40).map(a => `<tr><td>${new Date(a.ts).toLocaleString()}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</table></div></div>`;
}
async function applyRange() { const a = $('#rf').value, b = $('#rt').value; if (!a || !b || b < a) return toast('Choose a valid date range.', true); RF = a; RT = b; await run(async () => { }); }
function csv() {
  const rows = [['ref', 'time', 'dept', 'sold_by', 'total', 'status', 'payment']].concat(S.sales.filter(s => dayOf(s.ts) >= RF && dayOf(s.ts) <= RT).map(s => [s.id, s.ts, s.dept, s.staffName, s.total, s.status, s.pay]));
  download(new Blob([rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' }), 'sales.csv'); toast('Covers the latest 500 sales. For everything, use the full backup on the Users tab.');
}

/* ---------------------------------------------------------------- users, backup, data loading (admin) */
function vUsers() {
  return `<div class="card"><h3>Users &amp; roles</h3><div class="tw"><table><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr>${S.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role}</td><td>${u.active ? 'active' : 'disabled'}</td><td><button onclick="toggleUser('${u.id}')">${u.active ? 'Disable' : 'Enable'}</button> <button onclick="resetPw('${u.id}')">Reset password</button></td></tr>`).join('')}</table></div>
 <h3>Add a user</h3><div class="row"><div><label for="u_n">Full name</label><input id="u_n"></div><div><label for="u_u">Username (letters, numbers, . _ -)</label><input id="u_u" autocapitalize="none"></div><div><label for="u_r">Role</label><select id="u_r">${ROLES.map(r => `<option ${r === 'cashier' ? 'selected' : ''}>${r}</option>`).join('')}</select></div><div><label for="u_p">Password (8+ characters)</label><input id="u_p" type="password" autocomplete="new-password"></div><button class="p" onclick="addUser()">Add user</button></div>
 <p class="muted">Permissions are enforced on the server for every action, not just hidden in this screen.</p></div>
 <div class="card"><h3>Backup</h3><p class="muted">Downloads a full copy of all records as a JSON file. Keep it somewhere safe.</p><button onclick="backup()">Download full backup</button></div>
 <div class="card"><h3>Load data</h3><p><button onclick="loadStarter()">Load starter menu &amp; rooms</button></p><p class="muted">Adds the bar price list, restaurant dishes, ingredients and 5 rooms from the earlier version, with stock 0. Bar prices are blank and must be set under Stock. Items that already exist are skipped.</p>
 <p><label for="imp">Import data from the old browser version (JSON file)</label><br><input type="file" id="imp" accept=".json,application/json" onchange="importOld(this)"></p><p class="muted">In the old app's browser, open the developer console and run <code>copy(localStorage.getItem('hosp_pos'))</code>, then paste into a text file saved as .json. Products, recipes, rooms and expenses are imported. Old sales and bookings are not; keep that file as your archive.</p></div>`;
}
async function addUser() {
  const n = $('#u_n').value.trim(), un = $('#u_u').value.trim(), p = $('#u_p').value; if (!n || !un || !p) return toast('Name, username and password are required.', true);
  run(() => api('POST', '/api/user/create', { name: n, username: un, role: $('#u_r').value, password: p }), 'User added');
}
const toggleUser = id => run(() => api('POST', '/api/user/toggle', { id }));
async function resetPw(id) { const u = S.users.find(x => x.id === id), v = await form('Reset password: ' + u.name, [{ key: 'p', label: 'New password (8+ characters)', type: 'password', required: true }], 'Reset password'); if (v) run(() => api('POST', '/api/user/reset', { id, password: v.p }), 'Password updated. That user was signed out.'); }
const backup = () => act(async () => { const d = await api('GET', '/api/admin/export'); download(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' }), 'savanna-pos-backup-' + today() + '.json'); }, 'Backup downloaded');
function starter() {
  const L = [], g = (grp, items) => items.forEach(i => L.push([grp + ' – ' + i, 'Spirits'])), one = (arr, cat) => arr.forEach(n => L.push([n, cat]));
  g('BEST MZINGA', ['GIN', 'VODKA', 'WHYSKY']); one(['HUNTERS QUARTER 250ML', 'HUNTERS QUARTER 350ML', 'HUNTERS MUZINGA 750ML', 'BLUE ICE', 'KONYAGI', 'KEN EXTRA 250 ML'], 'Spirits');
  g('CAPTAIN MORGAN', ['QUARTER', 'MZINGA']); g('GENERAL MEKINS', ['QUARTER', 'MZINGA']); g('KIBAO QUARTER', ['VODKA', 'GIN']); g('KIBAO MZINGA', ['VODKA', 'GIN']); one(['V AND A QUARTER', 'V AND A MZINGA'], 'Spirits');
  one(['TRIPPLE ACE', 'WHITE CAP', 'BALOZI', 'TUSKER', 'GUNNERS'], 'Beer'); one(['SODA', 'UARANA', 'SODA 300ML', '99 MINUTE MAID'], 'Soft'); one(['GILIBYS', 'KEN EXTRA 750ML', 'KENYAGI 750ML', 'ORIGIN 250ML'], 'Spirits'); one(['SODA 500ML'], 'Soft'); one(['KENYA KING 250ML', 'PEOPLE VODKA 250ML'], 'Spirits');
  one(['LEMONADE', 'PREDATOR', 'MAJI', 'MANGO JUICY', 'REDBULL', 'FAX'], 'Soft'); g('CHROME QUARTER', ['VODKA', 'GIN']); g('CHROME MZINGA', ['VODKA', 'GIN']); g('COUNTY', ['QUARTER', 'MZINGA']); g('KC QUARTER', ['PINABLE', 'GINGER', 'SMOOTH']); g('KC MZINGA', ['PINABLE', 'GINGER', 'SMOOTH']); g('BEST QUARTER', ['GIN', 'VODKA', 'WHYSKY']);
  one(['VICEROY MZINGA', 'VICEROY NUSA', 'VICEROY QUATER'], 'Spirits'); one(['TUSKER CAN', 'TUSKER CIDER', 'GUINES CAN'], 'Beer'); one(['CAPTAIN COLD', 'DALLASBRANDY', 'CHROME BRANDY'], 'Spirits'); one(['SAVANNA'], 'Beer'); one(['MAJI 500ML', 'LEMON PUNCH'], 'Soft'); one(['RICHOT BRANDY', 'TRIPPLE ACE 750ML'], 'Spirits');
  const products = L.map((x, i) => ({ id: 'b' + i, name: x[0], cat: x[1], dept: 'bar', price: 0, cost: 0, stock: 0, reorder: 5, active: true }));
  [['Beef (kg)', 'Ingredient', 900], ['Chicken (pcs)', 'Ingredient', 450], ['Maize flour (kg)', 'Ingredient', 130]].forEach((x, i) => products.push({ id: 'i' + i, name: x[0], cat: x[1], dept: 'store', price: 0, cost: x[2], stock: 0, reorder: 5, active: true }));
  [['Nyama Choma 1/2kg', 900, 520, [{ pid: 'i0', qty: 0.5 }]], ['Chicken & Chips', 700, 380, [{ pid: 'i1', qty: 1 }]], ['Ugali Sukuma', 250, 90, [{ pid: 'i2', qty: 0.3 }]], ['Tea', 80, 20, undefined]].forEach((x, i) => products.push({ id: 'r' + i, name: x[0], cat: x[0] === 'Tea' ? 'Drinks' : 'Food', dept: 'rest', price: x[1], cost: x[2], stock: 0, reorder: 10, active: true, recipe: x[3] }));
  return { products, rooms: [['1', 'Single', 2500], ['2', 'Single', 2500], ['3', 'Double', 3500], ['4', 'Double', 3500], ['5', 'Suite', 6000]].map(r => ({ no: r[0], type: r[1], rate: r[2], status: 'vacant' })) };
}
async function loadStarter() {
  if (!confirm('Load the starter menu and rooms? Existing items with the same name are skipped.')) return;
  let r; if (await act(async () => { r = await api('POST', '/api/admin/import', starter()); await after(); })) alert('Done. Added ' + r.imported.products + ' items. Now open Stock to set prices and receive your opening stock.'); render();
}
function importOld(inp) {
  const f = inp.files[0]; if (!f) return; const rd = new FileReader();
  rd.onload = async () => {
    let d; try { d = JSON.parse(rd.result); } catch (e) { inp.value = ''; return toast('That file is not valid JSON.', true); }
    if (!d || !Array.isArray(d.products)) { inp.value = ''; return toast('That does not look like an export from the old Savanna POS.', true); }
    if (!confirm('Import ' + d.products.length + ' products, ' + (d.rooms || []).length + ' rooms and ' + (d.expenses || []).length + ' expenses? Existing items with the same name are skipped.')) { inp.value = ''; return; }
    let r; const ok = await act(async () => { r = await api('POST', '/api/admin/import', d); await after(); }); inp.value = ''; render();
    if (ok && r) alert('Imported ' + r.imported.products + ' products and ' + r.imported.expenses + ' expenses.\n\n' + r.skipped.note);
  };
  rd.readAsText(f);
}

/* ---------------------------------------------------------------- start */
async function boot() {
  render();
  try { const st = await api('GET', '/api/status'); if (st.needsSetup) { AUTH = 'setup'; render(); return; } }
  catch (e) { AUTH = 'login'; ERR = e.message; render(); return; }
  try { await refresh(); await pre(TAB); } catch (e) { ME = null; }
  AUTH = ME ? 'app' : 'login'; render();
}
boot();
