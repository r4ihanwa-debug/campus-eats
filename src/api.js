const crypto = require('crypto');
const { q, tx, now, hashPw, verifyPw, createUser } = require('./db');
const payment = require('./payment');

/* ---------- util ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
const setting = k => q.get('SELECT value FROM settings WHERE key=?', k)?.value;
const feeFor = f => Number(setting('fee_' + f));
const TERMINAL = ['SELESAI', 'DIBATALKAN'];
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${label} tidak valid`);
  return n;
};
const str = (v, min, max, label) => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) bad(`${label} harus ${min}-${max} karakter`);
  return s;
};
const json = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const notify = (uid, title, body, link) =>
  uid && q.run('INSERT INTO notifications(user_id,title,body,link,created_at) VALUES(?,?,?,?,?)', uid, title, body ?? null, link ?? null, now());
const notifyAdmins = (title, body, link) =>
  q.all("SELECT id FROM users WHERE role='admin' AND deleted=0").forEach(a => notify(a.id, title, body, link));
const merchantOf = u => q.get('SELECT * FROM merchants WHERE owner_id=?', u.id) || bad('Toko belum tersedia', 404);
const ownerOfMerchant = id => q.get('SELECT owner_id FROM merchants WHERE id=?', id)?.owner_id;

function credit(userId, amount, type, desc, orderId) {
  const w = q.get('SELECT id FROM wallets WHERE user_id=?', userId);
  q.run('UPDATE wallets SET balance=balance+? WHERE id=?', amount, w.id);
  q.run('INSERT INTO wallet_transactions(wallet_id,order_id,type,amount,description,created_at) VALUES(?,?,?,?,?,?)',
    w.id, orderId ?? null, type, amount, desc, now());
}
function newCode() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  for (;;) {
    const c = `CE-${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${crypto.randomInt(1000, 9999)}`;
    if (!q.get('SELECT 1 x FROM orders WHERE code=?', c)) return c;
  }
}

/* ---------- harga & variasi ---------- */
function variantsOf(pid) { return q.all('SELECT * FROM product_variants WHERE product_id=? ORDER BY sort,id', pid); }
function groupsOf(vs) {
  const map = new Map();
  vs.forEach(v => { if (!map.has(v.group_name)) map.set(v.group_name, []); map.get(v.group_name).push(v); });
  return [...map.entries()].map(([name, items]) => ({ name, items, required: items.some(i => i.required), show_if: items[0].show_if }));
}
function priceItem(p, opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  let unit = p.base_price; const sel = {};
  for (const g of groupsOf(variantsOf(p.id))) {
    if (g.show_if) { const [k, val] = g.show_if.split('='); if (opts[k] !== val) continue; }
    const pick = opts[g.name];
    if (!pick) { if (g.required) bad(`Pilih ${g.name} terlebih dahulu`); continue; }
    const v = g.items.find(i => i.label === pick) || bad(`Pilihan ${g.name} tidak valid`);
    unit += v.price_delta; sel[g.name] = pick;
  }
  return { unit, sel, text: Object.entries(sel).map(([g, l]) => `${g}: ${l}`).join(', ') };
}
function defaultOptions(p) {
  const opts = {};
  for (const g of groupsOf(variantsOf(p.id))) {
    if (g.show_if) { const [k, val] = g.show_if.split('='); if (opts[k] !== val) continue; }
    const d = g.items.find(i => i.is_default) || g.items[0];
    opts[g.name] = d.label;
  }
  return opts;
}
function productView(p, uid) {
  return {
    ...p, active: !!p.active, popular: !!p.popular,
    category: q.get('SELECT name FROM categories WHERE id=?', p.category_id)?.name,
    available: !!p.active && p.stock > 0,
    fav: uid ? !!q.get('SELECT 1 x FROM favorites WHERE user_id=? AND product_id=?', uid, p.id) : false,
    groups: groupsOf(variantsOf(p.id)).map(g => ({
      name: g.name, required: g.required, show_if: g.show_if,
      items: g.items.map(i => ({ label: i.label, price_delta: i.price_delta, is_default: !!i.is_default })),
    })),
  };
}

/* ---------- voucher ---------- */
function applyVoucher(code, items, subtotal, fee) {
  if (!code) return { discount: 0, voucher: null };
  const v = q.get('SELECT * FROM vouchers WHERE code=? AND active=1', String(code).trim()) || bad('Voucher tidak ditemukan atau tidak aktif');
  if (subtotal < v.min_subtotal) bad(`Voucher ${v.code} butuh belanja minimal ${rp(v.min_subtotal)}`);
  if (v.product_id && !items.some(i => i.product_id === v.product_id)) bad(`Voucher ${v.code} hanya berlaku untuk menu tertentu`);
  let d = v.type === 'free_shipping' ? (v.value > 0 ? Math.min(fee, v.value) : fee)
    : v.type === 'percent' ? Math.floor(subtotal * v.value / 100) : v.value;
  d = Math.max(0, Math.min(d, subtotal + fee));
  return { discount: d, voucher: v.code };
}

/* ---------- stok ---------- */
function reserveStock(productId, qty) {
  const r = q.run('UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1 AND deleted=0', qty, productId, qty);
  if (r.changes !== 1) {
    const p = q.get('SELECT name,stock FROM products WHERE id=?', productId);
    bad(`Stok ${p?.name || 'menu'} tidak mencukupi${p ? ` (tersisa ${p.stock})` : ''}`, 409);
  }
}
const releaseStock = orderId => q.all('SELECT product_id,qty FROM order_items WHERE order_id=?', orderId)
  .forEach(i => q.run('UPDATE products SET stock=stock+? WHERE id=?', i.qty, i.product_id));

/* ---------- status pesanan ---------- */
function refresh(id) {
  const o = q.get('SELECT * FROM orders WHERE id=?', id);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') return o;
  let s;
  if (o.delivery_stage === 2) s = 'DALAM_PENGANTARAN';
  else if (o.delivery_stage === 1) s = 'KURIR_MENGAMBIL';
  else if (o.food_state === 3) s = 'SIAP_DIAMBIL';
  else if (o.food_state === 2) s = 'SEDANG_DISIAPKAN';
  else if (o.courier_id) s = o.food_state === 1 ? 'MENUNGGU_DISIAPKAN' : 'KURIR_DITEMUKAN';
  else s = 'MENCARI_KURIR';
  if (s !== o.status) q.run('UPDATE orders SET status=? WHERE id=?', s, id);
  return { ...o, status: s };
}

function markPaid(orderId) {
  const o = tx(() => {
    const r = q.run("UPDATE orders SET status='PEMBAYARAN_BERHASIL', paid_at=? WHERE id=? AND status='MENUNGGU_PEMBAYARAN'", now(), orderId);
    if (r.changes !== 1) bad('Pesanan tidak dalam status menunggu pembayaran', 409);
    q.run("UPDATE payments SET status='PAID', paid_at=? WHERE order_id=? AND status='PENDING'", now(), orderId);
    const o = refresh(orderId);
    notify(o.customer_id, 'Pembayaran berhasil', `Pesanan ${o.code} sedang dicarikan kurir.`, `#/order/${o.id}`);
    notify(ownerOfMerchant(o.merchant_id), 'Pesanan online baru', `${o.code} - ${rp(o.subtotal)}. Segera terima pesanan.`, '#/m/orders');
    notifyAdmins('Transaksi baru', `${o.code} senilai ${rp(o.total)}`, '#/a/transactions');
    return o;
  });
  dispatch(o.id);
}

function cancelOrder(id, reason, who) {
  return tx(() => {
    const o = q.get('SELECT * FROM orders WHERE id=?', id);
    if (!o || TERMINAL.includes(o.status)) bad('Pesanan tidak bisa dibatalkan', 409);
    const paid = o.status !== 'MENUNGGU_PEMBAYARAN';
    q.run("UPDATE orders SET status='DIBATALKAN', cancel_reason=?, courier_search='' WHERE id=?", reason, id);
    q.run("UPDATE deliveries SET status='cancelled', responded_at=? WHERE order_id=? AND status IN('offered','accepted')", now(), id);
    releaseStock(id);
    q.run('UPDATE payments SET status=? WHERE order_id=? AND status IN(\'PENDING\',\'PAID\')', paid ? 'REFUNDED' : 'CANCELLED', id);
    if (paid && o.customer_id) credit(o.customer_id, o.total, 'refund', `Refund pesanan ${o.code}`, id);
    notify(o.customer_id, 'Pesanan dibatalkan', `${o.code}: ${reason}${paid ? `. Saldo refund ${rp(o.total)} sudah masuk.` : ''}`, `#/order/${id}`);
    if (paid) notify(ownerOfMerchant(o.merchant_id), 'Pesanan dibatalkan', `${o.code}: ${reason}`, '#/m/orders');
    if (o.courier_id) notify(o.courier_id, 'Pesanan dibatalkan', `${o.code} dibatalkan: ${reason}`, '#/c/active');
    return q.get('SELECT * FROM orders WHERE id=?', id);
  });
}

/* ---------- pencarian kurir ---------- */
const activeJobs = '(SELECT COUNT(*) FROM orders x WHERE x.courier_id=u.id AND x.status NOT IN(\'SELESAI\',\'DIBATALKAN\'))';
function dispatch(orderId) {
  const o = q.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o || o.type !== 'online' || o.courier_id || o.status === 'MENUNGGU_PEMBAYARAN' || TERMINAL.includes(o.status)) return;
  if (q.get("SELECT 1 x FROM deliveries WHERE order_id=? AND status='offered'", orderId)) return;
  const c = q.get(`SELECT u.id FROM users u JOIN courier_profiles cp ON cp.user_id=u.id
    WHERE u.role='courier' AND u.active=1 AND u.deleted=0 AND cp.online=1
      AND u.id NOT IN (SELECT courier_id FROM deliveries WHERE order_id=?)
      AND u.id NOT IN (SELECT courier_id FROM deliveries WHERE status='offered')
      AND ${activeJobs} < 2
    ORDER BY ${activeJobs} ASC, cp.last_offer_at ASC, u.id ASC LIMIT 1`, orderId);
  if (!c) {
    if (o.courier_search !== 'none') {
      q.run("UPDATE orders SET courier_search='none' WHERE id=?", orderId);
      notify(o.customer_id, 'Belum ada kurir tersedia', 'Kamu bisa menunggu atau membatalkan pesanan dengan refund.', `#/order/${orderId}`);
    }
    return;
  }
  const t = now();
  q.run("INSERT INTO deliveries(order_id,courier_id,status,offered_at,expires_at) VALUES(?,?,'offered',?,?)", orderId, c.id, t, t + Number(setting('offer_timeout_sec')) * 1000);
  q.run('UPDATE courier_profiles SET last_offer_at=? WHERE user_id=?', t, c.id);
  if (o.courier_search) q.run("UPDATE orders SET courier_search='' WHERE id=?", orderId);
  notify(c.id, 'Pesanan baru!', `${rp(o.delivery_fee)} - Lantai ${o.floor}, Ruang ${o.room}`, '#/c/available');
}

function tick() {
  try {
    const t = now();
    q.all("SELECT id,order_id FROM deliveries WHERE status='offered' AND expires_at<?", t).forEach(d => {
      q.run("UPDATE deliveries SET status='expired', responded_at=? WHERE id=?", t, d.id);
      dispatch(d.order_id);
    });
    q.all("SELECT id FROM orders WHERE type='online' AND courier_id IS NULL AND status NOT IN('MENUNGGU_PEMBAYARAN','SELESAI','DIBATALKAN')").forEach(o => dispatch(o.id));
    const limit = t - Number(setting('payment_timeout_sec')) * 1000;
    q.all("SELECT id FROM orders WHERE status='MENUNGGU_PEMBAYARAN' AND created_at<?", limit).forEach(o => {
      try { cancelOrder(o.id, 'Waktu pembayaran habis', 'system'); } catch {}
    });
    q.run('DELETE FROM sessions WHERE expires_at<?', t);
  } catch (e) { console.error('tick error:', e.message); }
}

function settle(orderId) {
  tx(() => {
    const r = q.run("UPDATE orders SET settled=1 WHERE id=? AND settled=0 AND status='SELESAI'", orderId);
    if (r.changes !== 1) return;
    const o = q.get('SELECT * FROM orders WHERE id=?', orderId);
    const pct = Number(setting('commission_pct')) || 0;
    const commission = Math.round(o.subtotal * pct / 100);
    credit(ownerOfMerchant(o.merchant_id), o.subtotal - commission, 'sale', `Penjualan ${o.code}`, orderId);
    credit(o.courier_id, o.delivery_fee, 'delivery_fee', `Ongkir ${o.code}`, orderId);
    const admin = q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
    if (commission) credit(admin.id, commission, 'commission', `Komisi ${o.code}`, orderId);
    if (o.discount) credit(admin.id, -o.discount, 'voucher', `Subsidi voucher ${o.voucher_code || ''} ${o.code}`, orderId);
    q.all('SELECT product_id,qty FROM order_items WHERE order_id=?', orderId).forEach(i => q.run('UPDATE products SET sold=sold+? WHERE id=?', i.qty, i.product_id));
  });
}

/* ---------- serializer ---------- */
function orderView(o, viewer) {
  const items = q.all('SELECT * FROM order_items WHERE order_id=?', o.id);
  const m = q.get('SELECT id,name,location,eta_min FROM merchants WHERE id=?', o.merchant_id);
  const courier = o.courier_id ? q.get('SELECT u.id,u.name,u.phone,cp.rating_avg,cp.rating_count FROM users u JOIN courier_profiles cp ON cp.user_id=u.id WHERE u.id=?', o.courier_id) : null;
  const pay = q.get('SELECT method,provider,ref,status FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id);
  const customer = o.customer_id ? q.get('SELECT name,phone FROM users WHERE id=?', o.customer_id) : null;
  const rated = !!q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id);
  const view = {
    ...o, merchant: m, courier, payment: pay, rated, items,
    customer: viewer?.role === 'customer' ? undefined : customer,
    eta: m ? m.eta_min + Math.ceil((o.floor || 1) / 2) + 2 : null,
    payment_expires_at: o.status === 'MENUNGGU_PAYMENT' ? null : (o.status === 'MENUNGGU_PEMBAYARAN' ? o.created_at + Number(setting('payment_timeout_sec')) * 1000 : null),
  };
  if (viewer?.role === 'courier') { delete view.subtotal; delete view.discount; delete view.total; }
  return view;
}
function canSee(user, o) {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return o.customer_id === user.id;
  if (user.role === 'merchant') return ownerOfMerchant(o.merchant_id) === user.id;
  if (user.role === 'courier') return o.courier_id === user.id;
  return false;
}

/* ---------- laporan ---------- */
function report(mode, merchantId) {
  const days = mode === 'monthly' ? 6 : 14, keys = [], labels = [];
  const d = new Date(); d.setDate(1);
  for (let i = days - 1; i >= 0; i--) {
    const x = mode === 'monthly' ? new Date(d.getFullYear(), d.getMonth() - i, 1) : new Date(Date.now() - i * 86400000);
    const p = n => String(n).padStart(2, '0');
    keys.push(mode === 'monthly' ? `${x.getFullYear()}-${p(x.getMonth() + 1)}` : `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`);
    labels.push(mode === 'monthly' ? x.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' }) : x.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }));
  }
  const fmt = mode === 'monthly' ? '%Y-%m' : '%Y-%m-%d';
  const rows = q.all(`SELECT strftime('${fmt}', COALESCE(completed_at,created_at)/1000,'unixepoch','localtime') k, type, COUNT(*) n, SUM(subtotal) s, SUM(delivery_fee) f
    FROM orders WHERE status='SELESAI' ${merchantId ? 'AND merchant_id=?' : ''} GROUP BY k,type`, ...(merchantId ? [merchantId] : []));
  const out = { labels, online: keys.map(() => 0), offline: keys.map(() => 0), orders: keys.map(() => 0), fees: keys.map(() => 0) };
  rows.forEach(r => {
    const i = keys.indexOf(r.k); if (i < 0) return;
    out[r.type][i] += r.s; out.orders[i] += r.n; out.fees[i] += r.f || 0;
  });
  out.total = out.online.reduce((a, b) => a + b, 0) + out.offline.reduce((a, b) => a + b, 0);
  out.count = out.orders.reduce((a, b) => a + b, 0);
  return out;
}
function walletInfo(uid) {
  const w = q.get('SELECT * FROM wallets WHERE user_id=?', uid);
  const sum = since => q.get('SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions WHERE wallet_id=? AND amount>0 AND type!=\'refund\' AND created_at>=?', w.id, since).s;
  const d = new Date(); const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { balance: w.balance, today: sum(day), month: sum(month), transactions: q.all('SELECT * FROM wallet_transactions WHERE wallet_id=? ORDER BY id DESC LIMIT 100', w.id) };
}

/* ---------- router ---------- */
const routes = [];
function R(method, path, roles, fn) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, roles, fn });
}
const ANY = null;

/* AUTH */
const fails = new Map();
const cookieOpts = (age) => `; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}`;
R('POST', '/api/auth/login', ANY, ctx => {
  const username = String(ctx.body.username || '').trim(), key = ctx.ip + '|' + username.toLowerCase();
  const f = fails.get(key);
  if (f && f.n >= 5 && now() - f.t < 600000) bad('Terlalu banyak percobaan login. Coba lagi dalam 10 menit.', 429);
  const u = q.get('SELECT * FROM users WHERE username=? AND deleted=0', username);
  if (!u || !verifyPw(String(ctx.body.password || ''), u.password_hash)) {
    fails.set(key, { n: (f && now() - f.t < 600000 ? f.n : 0) + 1, t: now() });
    bad('Username atau password salah', 401);
  }
  if (!u.active) bad('Akun dinonaktifkan. Hubungi admin Campus Eats.', 403);
  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, u.id, now() + 7 * 864e5);
  ctx.setCookie = `ce_sid=${token}${cookieOpts(7 * 86400)}`;
  return { user: publicUser(u) };
});
R('POST', '/api/auth/logout', ANY, ctx => {
  if (ctx.token) q.run('DELETE FROM sessions WHERE token=?', ctx.token);
  ctx.setCookie = `ce_sid=${cookieOpts(0)}`;
  return { ok: true };
});
R('POST', '/api/auth/register', ANY, ctx => {
  const b = ctx.body;
  const role = ['customer', 'courier', 'merchant'].includes(b.role) ? b.role : bad('Jenis akun tidak valid');
  const username = String(b.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) bad('Username 3-20 karakter (huruf, angka, underscore)');
  const password = String(b.password || '');
  if (password.length < 6 || password.length > 72) bad('Password minimal 6 karakter');
  const name = str(b.name, 2, 60, 'Nama');
  const phone = b.phone ? str(b.phone, 8, 16, 'No. HP') : null;
  if (phone && !/^[0-9+]+$/.test(phone)) bad('No. HP hanya boleh berisi angka');
  if (q.get('SELECT 1 x FROM users WHERE username=?', username)) bad('Username sudah dipakai', 409);
  const id = tx(() => {
    const id = createUser({ username, password, role, name, phone });
    if (role === 'merchant') q.run('INSERT INTO merchants(owner_id,name,description,open) VALUES(?,?,?,0)', id, str(b.store_name || name, 3, 50, 'Nama kantin'), 'Kantin baru di Campus Eats.');
    notifyAdmins(role === 'courier' ? 'Kurir baru' : role === 'merchant' ? 'Kantin baru' : 'Pengguna baru', `${name} (@${username}) mendaftar`, '#/a/users');
    return id;
  });
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, id, now() + 7 * 864e5);
  ctx.setCookie = `ce_sid=${token}${cookieOpts(7 * 86400)}`;
  return { user: publicUser(q.get('SELECT * FROM users WHERE id=?', id)) };
});
function publicUser(u) {
  const out = { id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone };
  if (u.role === 'customer') {
    Object.assign(out, q.get('SELECT default_floor,default_room FROM customer_profiles WHERE user_id=?', u.id));
    out.refund_balance = q.get('SELECT balance FROM wallets WHERE user_id=?', u.id).balance;
  }
  if (u.role === 'courier') Object.assign(out, q.get('SELECT online,rating_avg,rating_count FROM courier_profiles WHERE user_id=?', u.id));
  if (u.role === 'merchant') out.merchant = q.get('SELECT * FROM merchants WHERE owner_id=?', u.id);
  return out;
}
R('GET', '/api/me', ANY, ctx => ({ user: ctx.user ? publicUser(ctx.user) : null }));
R('PUT', '/api/profile', ['customer', 'courier', 'merchant', 'admin'], ctx => {
  const b = ctx.body, u = ctx.user;
  const name = str(b.name, 2, 60, 'Nama');
  const phone = b.phone ? str(b.phone, 8, 16, 'No. HP') : null;
  if (phone && !/^[0-9+]+$/.test(phone)) bad('No. HP hanya boleh berisi angka');
  q.run('UPDATE users SET name=?, phone=? WHERE id=?', name, phone, u.id);
  if (u.role === 'customer') {
    const f = b.default_floor ? int(b.default_floor, 1, 9, 'Lantai') : null, r = b.default_room ? int(b.default_room, 101, 120, 'Ruang') : null;
    q.run('UPDATE customer_profiles SET default_floor=?, default_room=? WHERE user_id=?', f, r, u.id);
  }
  return { user: publicUser(q.get('SELECT * FROM users WHERE id=?', u.id)) };
});
R('POST', '/api/profile/password', ['customer', 'courier', 'merchant', 'admin'], ctx => {
  if (!verifyPw(String(ctx.body.current || ''), ctx.user.password_hash)) bad('Password lama salah');
  const n = String(ctx.body.next || '');
  if (n.length < 6 || n.length > 72) bad('Password baru minimal 6 karakter');
  q.run('UPDATE users SET password_hash=? WHERE id=?', hashPw(n), ctx.user.id);
  return { ok: true };
});

/* NOTIFIKASI */
R('GET', '/api/notifications', ANY, ctx => {
  if (!ctx.user) bad('Silakan login', 401);
  return {
    items: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', ctx.user.id),
    unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', ctx.user.id).c,
  };
});
R('POST', '/api/notifications/read', ANY, ctx => {
  if (!ctx.user) bad('Silakan login', 401);
  q.run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id); return { ok: true };
});
R('POST', '/api/complaints', ['customer', 'courier', 'merchant'], ctx => {
  const b = ctx.body;
  let oid = null;
  if (b.order_id) { const o = q.get('SELECT * FROM orders WHERE id=?', Number(b.order_id)); if (!o || !canSee(ctx.user, o)) bad('Pesanan tidak ditemukan', 404); oid = o.id; }
  q.run('INSERT INTO complaints(user_id,order_id,subject,message,created_at) VALUES(?,?,?,?,?)', ctx.user.id, oid, str(b.subject, 3, 80, 'Judul'), str(b.message, 5, 1000, 'Pesan'), now());
  notifyAdmins('Pengaduan baru', `${ctx.user.name}: ${String(b.subject).slice(0, 60)}`, '#/a/reports');
  return { ok: true };
});

/* KATALOG (customer) */
R('GET', '/api/merchants', ['customer'], () => ({
  merchants: q.all('SELECT m.* FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.active=1 AND u.deleted=0').map(m => ({ ...m, open: !!m.open })),
  categories: q.all('SELECT * FROM categories ORDER BY id'),
}));
R('GET', '/api/menu', ['customer'], ctx => {
  const qs = String(ctx.query.q || '').toLowerCase(), cat = ctx.query.cat;
  let rows = q.all(`SELECT p.* FROM products p JOIN merchants m ON m.id=p.merchant_id JOIN users u ON u.id=m.owner_id
    WHERE p.deleted=0 AND p.active=1 AND u.active=1 AND u.deleted=0 ORDER BY p.popular DESC, p.sold DESC`).map(p => productView(p, ctx.user.id));
  if (cat && cat !== 'Semua') rows = rows.filter(p => p.category === cat);
  if (qs) rows = rows.filter(p => p.name.toLowerCase().includes(qs) || (p.category || '').toLowerCase().includes(qs));
  return { products: rows };
});
R('GET', '/api/products/:id', ['customer'], ctx => {
  const p = q.get('SELECT * FROM products WHERE id=? AND deleted=0', Number(ctx.params.id)) || bad('Menu tidak ditemukan', 404);
  const m = q.get('SELECT id,name,open,eta_min FROM merchants WHERE id=?', p.merchant_id);
  return { product: productView(p, ctx.user.id), merchant: { ...m, open: !!m.open } };
});
R('GET', '/api/favorites', ['customer'], ctx => ({
  products: q.all('SELECT p.* FROM products p JOIN favorites f ON f.product_id=p.id WHERE f.user_id=? AND p.deleted=0', ctx.user.id).map(p => productView(p, ctx.user.id)),
}));
R('POST', '/api/favorites/:id', ['customer'], ctx => {
  const pid = Number(ctx.params.id);
  if (!q.get('SELECT 1 x FROM products WHERE id=? AND deleted=0', pid)) bad('Menu tidak ditemukan', 404);
  const has = q.get('SELECT 1 x FROM favorites WHERE user_id=? AND product_id=?', ctx.user.id, pid);
  if (has) q.run('DELETE FROM favorites WHERE user_id=? AND product_id=?', ctx.user.id, pid);
  else q.run('INSERT INTO favorites(user_id,product_id) VALUES(?,?)', ctx.user.id, pid);
  return { fav: !has };
});
R('GET', '/api/fees', ['customer'], () => ({
  fees: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(f => [f, feeFor(f)])),
  vouchers: q.all('SELECT v.*, p.name product_name FROM vouchers v LEFT JOIN products p ON p.id=v.product_id WHERE v.active=1'),
}));

/* KERANJANG */
function cartView(uid) {
  const cart = q.get('SELECT id FROM carts WHERE user_id=?', uid);
  const items = q.all('SELECT * FROM cart_items WHERE cart_id=? ORDER BY id', cart.id).map(ci => {
    const p = q.get('SELECT * FROM products WHERE id=?', ci.product_id);
    let price = { unit: p.base_price, text: '' }, invalid = null;
    try { price = priceItem(p, json(ci.options)); } catch (e) { invalid = e.message; }
    if (!p.active || p.deleted) invalid = 'Menu tidak tersedia';
    else if (p.stock < ci.qty) invalid = `Stok tersisa ${p.stock}`;
    return {
      id: ci.id, qty: ci.qty, note: ci.note, options: json(ci.options), unit: price.unit, text: price.text, total: price.unit * ci.qty, invalid,
      product: { id: p.id, name: p.name, image: p.image, stock: p.stock, merchant_id: p.merchant_id },
    };
  });
  const merchant = items[0] ? q.get('SELECT id,name,open FROM merchants WHERE id=?', items[0].product.merchant_id) : null;
  return { items, subtotal: items.reduce((s, i) => s + i.total, 0), count: items.reduce((s, i) => s + i.qty, 0), merchant };
}
R('GET', '/api/cart', ['customer'], ctx => cartView(ctx.user.id));
R('POST', '/api/cart/items', ['customer'], ctx => {
  const b = ctx.body;
  const p = q.get('SELECT * FROM products WHERE id=? AND deleted=0 AND active=1', Number(b.product_id)) || bad('Menu tidak tersedia', 404);
  const qty = int(b.qty ?? 1, 1, 20, 'Jumlah');
  const price = priceItem(p, b.options);
  const cart = q.get('SELECT id FROM carts WHERE user_id=?', ctx.user.id);
  const other = q.get('SELECT p.merchant_id FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=? LIMIT 1', cart.id);
  if (other && other.merchant_id !== p.merchant_id) bad('Keranjang hanya bisa berisi menu dari satu kantin', 409);
  const note = b.note ? String(b.note).slice(0, 200) : null, opts = JSON.stringify(price.sel);
  const same = q.get('SELECT * FROM cart_items WHERE cart_id=? AND product_id=? AND options=? AND COALESCE(note,\'\')=?', cart.id, p.id, opts, note || '');
  const total = (same?.qty || 0) + qty;
  if (total > 20) bad('Maksimal 20 porsi per item');
  if (total > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409);
  if (same) q.run('UPDATE cart_items SET qty=? WHERE id=?', total, same.id);
  else q.run('INSERT INTO cart_items(cart_id,product_id,options,note,qty) VALUES(?,?,?,?,?)', cart.id, p.id, opts, note, qty);
  return cartView(ctx.user.id);
});
function ownCartItem(ctx) {
  return q.get('SELECT ci.* FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=? AND c.user_id=?', Number(ctx.params.id), ctx.user.id) || bad('Item tidak ditemukan', 404);
}
R('PATCH', '/api/cart/items/:id', ['customer'], ctx => {
  const ci = ownCartItem(ctx), b = ctx.body;
  const p = q.get('SELECT * FROM products WHERE id=?', ci.product_id);
  const qty = b.qty !== undefined ? int(b.qty, 1, 20, 'Jumlah') : ci.qty;
  if (qty > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409);
  let opts = ci.options;
  if (b.options) opts = JSON.stringify(priceItem(p, b.options).sel);
  q.run('UPDATE cart_items SET qty=?, options=?, note=? WHERE id=?', qty, opts, b.note !== undefined ? String(b.note || '').slice(0, 200) || null : ci.note, ci.id);
  return cartView(ctx.user.id);
});
R('DELETE', '/api/cart/items/:id', ['customer'], ctx => { q.run('DELETE FROM cart_items WHERE id=?', ownCartItem(ctx).id); return cartView(ctx.user.id); });
R('POST', '/api/vouchers/check', ['customer'], ctx => {
  const cart = cartView(ctx.user.id);
  const fee = ctx.body.floor ? feeFor(int(ctx.body.floor, 1, 9, 'Lantai')) : 0;
  const r = applyVoucher(ctx.body.code, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
  return { ...r, message: `Voucher ${r.voucher} dipakai, hemat ${rp(r.discount)}` };
});

/* PESANAN (customer) */
R('POST', '/api/orders', ['customer'], ctx => {
  const b = ctx.body;
  const floor = int(b.floor, 1, 9, 'Lantai'), room = int(b.room, 101, 120, 'Ruang');
  const recipient = str(b.recipient, 2, 60, 'Nama penerima');
  const courierNote = b.courier_note ? String(b.courier_note).slice(0, 200) : null;
  const id = tx(() => {
    const cart = cartView(ctx.user.id);
    if (!cart.items.length) bad('Keranjang masih kosong');
    const bad1 = cart.items.find(i => i.invalid);
    if (bad1) bad(`${bad1.product.name}: ${bad1.invalid}`, 409);
    const m = q.get('SELECT m.*, u.active ua FROM merchants m JOIN users u ON u.id=m.owner_id WHERE m.id=?', cart.merchant.id);
    if (!m.open || !m.ua) bad('Kantin sedang tutup', 409);
    const fee = feeFor(floor);
    const v = applyVoucher(b.voucher, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
    const total = cart.subtotal + fee - v.discount;
    const code = newCode();
    const oid = Number(q.run(`INSERT INTO orders(code,customer_id,merchant_id,type,status,subtotal,delivery_fee,discount,total,voucher_code,floor,room,recipient,courier_note,created_at)
      VALUES(?,?,?,'online','MENUNGGU_PEMBAYARAN',?,?,?,?,?,?,?,?,?,?)`,
      code, ctx.user.id, m.id, cart.subtotal, fee, v.discount, total, v.voucher, floor, room, recipient, courierNote, now()).lastInsertRowid);
    for (const i of cart.items) {
      reserveStock(i.product.id, i.qty);
      q.run('INSERT INTO order_items(order_id,product_id,name,options_text,options_json,note,qty,unit_price) VALUES(?,?,?,?,?,?,?,?)',
        oid, i.product.id, i.product.name, i.text, JSON.stringify(i.options), i.note, i.qty, i.unit);
    }
    const ch = payment.createCharge({ code, total });
    q.run("INSERT INTO payments(order_id,method,provider,ref,amount,status,created_at) VALUES(?,'QRIS',?,?,?,'PENDING',?)", oid, payment.provider, ch.ref, total, now());
    q.run('DELETE FROM cart_items WHERE cart_id=(SELECT id FROM carts WHERE user_id=?)', ctx.user.id);
    return oid;
  });
  return { order: orderView(q.get('SELECT * FROM orders WHERE id=?', id), ctx.user) };
});
R('GET', '/api/orders', ['customer'], ctx => {
  const f = ctx.query.filter || 'all';
  let rows = q.all('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100', ctx.user.id);
  if (f === 'berhasil') rows = rows.filter(o => o.status === 'SELESAI');
  if (f === 'dibatalkan') rows = rows.filter(o => o.status === 'DIBATALKAN');
  if (f === 'aktif') rows = rows.filter(o => !TERMINAL.includes(o.status));
  return { orders: rows.map(o => orderView(o, ctx.user)) };
});
R('GET', '/api/orders/:id', ['customer', 'merchant', 'courier', 'admin'], ctx => {
  const o = q.get('SELECT * FROM orders WHERE id=?', Number(ctx.params.id));
  if (!o || !canSee(ctx.user, o)) bad('Pesanan tidak ditemukan', 404);
  return { order: orderView(o, ctx.user) };
});
function ownOrder(ctx) {
  const o = q.get('SELECT * FROM orders WHERE id=? AND customer_id=?', Number(ctx.params.id), ctx.user.id);
  return o || bad('Pesanan tidak ditemukan', 404);
}
R('POST', '/api/orders/:id/pay', ['customer'], ctx => {
  const o = ownOrder(ctx);
  if (o.status !== 'MENUNGGU_PEMBAYARAN') bad('Pesanan ini tidak menunggu pembayaran', 409);
  markPaid(o.id); // SIMULASI: pada gateway sungguhan dipanggil dari webhook terverifikasi
  return { order: orderView(q.get('SELECT * FROM orders WHERE id=?', o.id), ctx.user) };
});
R('POST', '/api/orders/:id/cancel', ['customer'], ctx => {
  const o = ownOrder(ctx);
  if (TERMINAL.includes(o.status)) bad('Pesanan sudah selesai/dibatalkan', 409);
  if (o.status !== 'MENUNGGU_PEMBAYARAN' && (o.food_state >= 2 || o.delivery_stage > 0))
    bad('Pesanan sudah diproses kantin/kurir sehingga tidak bisa dibatalkan. Hubungi bantuan jika ada masalah.', 409);
  const o2 = cancelOrder(o.id, String(ctx.body.reason || 'Dibatalkan oleh pembeli').slice(0, 120));
  return { order: orderView(o2, ctx.user) };
});
R('POST', '/api/orders/:id/retry-courier', ['customer'], ctx => {
  const o = ownOrder(ctx);
  if (o.courier_id || TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Tidak perlu mencari kurir lagi', 409);
  q.run("DELETE FROM deliveries WHERE order_id=? AND status IN('rejected','expired')", o.id);
  q.run("UPDATE orders SET courier_search='' WHERE id=?", o.id);
  dispatch(o.id);
  return { order: orderView(q.get('SELECT * FROM orders WHERE id=?', o.id), ctx.user) };
});
R('POST', '/api/orders/:id/rate', ['customer'], ctx => {
  const o = ownOrder(ctx), b = ctx.body;
  if (o.status !== 'SELESAI') bad('Rating hanya bisa diberikan setelah pesanan selesai', 409);
  if (q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id)) bad('Pesanan ini sudah dinilai', 409);
  const ms = int(b.merchant_stars, 1, 5, 'Rating kantin'), cs = int(b.courier_stars, 1, 5, 'Rating kurir');
  tx(() => {
    q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'merchant',?,?,?)", o.id, o.merchant_id, ms, now());
    q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'courier',?,?,?)", o.id, o.courier_id, cs, now());
    if (b.review) q.run('INSERT INTO reviews(order_id,customer_id,text,created_at) VALUES(?,?,?,?)', o.id, ctx.user.id, String(b.review).slice(0, 300), now());
    q.run('UPDATE merchants SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE id=?', ms, o.merchant_id);
    q.run('UPDATE courier_profiles SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE user_id=?', cs, o.courier_id);
  });
  return { ok: true };
});
R('POST', '/api/orders/:id/reorder', ['customer'], ctx => {
  const o = ownOrder(ctx);
  const cart = q.get('SELECT id FROM carts WHERE user_id=?', ctx.user.id);
  q.run('DELETE FROM cart_items WHERE cart_id=?', cart.id);
  let added = 0, skipped = 0;
  for (const i of q.all('SELECT * FROM order_items WHERE order_id=?', o.id)) {
    const p = q.get('SELECT * FROM products WHERE id=? AND active=1 AND deleted=0 AND stock>=?', i.product_id, i.qty);
    try {
      if (!p) throw 0;
      const pr = priceItem(p, json(i.options_json));
      q.run('INSERT INTO cart_items(cart_id,product_id,options,note,qty) VALUES(?,?,?,?,?)', cart.id, p.id, JSON.stringify(pr.sel), i.note, i.qty);
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
});

/* KURIR */
const COURIER = ['courier'];
R('POST', '/api/courier/online', COURIER, ctx => {
  const on = ctx.body.online ? 1 : 0;
  q.run('UPDATE courier_profiles SET online=? WHERE user_id=?', on, ctx.user.id);
  if (!on) q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE courier_id=? AND status='offered'", now(), ctx.user.id);
  if (on) tick();
  return { online: !!on };
});
function offerFor(uid) {
  const d = q.get("SELECT * FROM deliveries WHERE courier_id=? AND status='offered' AND expires_at>? ORDER BY id LIMIT 1", uid, now());
  if (!d) return null;
  const o = q.get('SELECT * FROM orders WHERE id=?', d.order_id), m = q.get('SELECT name,location FROM merchants WHERE id=?', o.merchant_id);
  return { id: d.id, code: o.code, order_id: o.id, merchant: m.name, pickup: m.location, floor: o.floor, room: o.room, fee: o.delivery_fee,
    items: q.get('SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE order_id=?', o.id).n, remaining: Math.max(0, Math.ceil((d.expires_at - now()) / 1000)),
    total_seconds: Number(setting('offer_timeout_sec')) };
}
R('GET', '/api/courier/offer', COURIER, ctx => ({ offer: offerFor(ctx.user.id) }));
R('POST', '/api/courier/offers/:id/accept', COURIER, ctx => {
  const oid = tx(() => {
    const d = q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered' AND expires_at>?", Number(ctx.params.id), ctx.user.id, now())
      || bad('Tawaran sudah kedaluwarsa atau diambil kurir lain', 409);
    const r = q.run("UPDATE orders SET courier_id=?, courier_search='' WHERE id=? AND courier_id IS NULL AND status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')", ctx.user.id, d.order_id);
    if (r.changes !== 1) bad('Pesanan sudah diambil kurir lain atau dibatalkan', 409);
    q.run("UPDATE deliveries SET status='accepted', responded_at=? WHERE id=?", now(), d.id);
    const o = refresh(d.order_id);
    notify(o.customer_id, 'Kurir ditemukan', `${ctx.user.name} akan mengantar pesananmu.`, `#/order/${o.id}`);
    notify(ownerOfMerchant(o.merchant_id), 'Kurir ditemukan', `${ctx.user.name} akan mengambil ${o.code}.`, '#/m/orders');
    notify(ctx.user.id, 'Pesanan diterima', `${o.code}: ambil di ${q.get('SELECT name FROM merchants WHERE id=?', o.merchant_id).name}, antar ke Lantai ${o.floor} Ruang ${o.room}.`, '#/c/active');
    return o.id;
  });
  return { order: orderView(q.get('SELECT * FROM orders WHERE id=?', oid), ctx.user) };
});
R('POST', '/api/courier/offers/:id/reject', COURIER, ctx => {
  const d = q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered'", Number(ctx.params.id), ctx.user.id) || bad('Tawaran tidak ditemukan', 404);
  q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE id=?", now(), d.id);
  dispatch(d.order_id);
  return { ok: true };
});
R('GET', '/api/courier/orders', COURIER, ctx => {
  const hist = ctx.query.history === '1';
  const rows = q.all(`SELECT * FROM orders WHERE courier_id=? AND status ${hist ? "IN('SELESAI','DIBATALKAN')" : "NOT IN('SELESAI','DIBATALKAN')"} ORDER BY id DESC LIMIT 100`, ctx.user.id);
  return { orders: rows.map(o => orderView(o, ctx.user)) };
});
function courierOrder(ctx) {
  return q.get('SELECT * FROM orders WHERE id=? AND courier_id=?', Number(ctx.params.id), ctx.user.id) || bad('Pesanan tidak ditemukan', 404);
}
R('POST', '/api/courier/orders/:id/arrived', COURIER, ctx => {
  const o = courierOrder(ctx);
  if (TERMINAL.includes(o.status) || o.delivery_stage !== 0) bad('Status pesanan tidak sesuai', 409);
  q.run('UPDATE orders SET delivery_stage=1 WHERE id=?', o.id); refresh(o.id);
  notify(ownerOfMerchant(o.merchant_id), 'Kurir sudah di kantin', `Kurir menunggu ${o.code}.`, '#/m/orders');
  notify(o.customer_id, 'Kurir mengambil pesanan', `Kurir sudah tiba di kantin untuk ${o.code}.`, `#/order/${o.id}`);
  return { ok: true };
});
R('POST', '/api/courier/orders/:id/pickup', COURIER, ctx => {
  const o = courierOrder(ctx);
  if (TERMINAL.includes(o.status) || o.delivery_stage > 1) bad('Status pesanan tidak sesuai', 409);
  if (o.food_state < 3) bad('Makanan belum ditandai siap oleh kantin', 409);
  q.run('UPDATE orders SET delivery_stage=2 WHERE id=?', o.id); refresh(o.id);
  notify(o.customer_id, 'Pesanan sedang diantar', `${o.code} dalam pengantaran ke Lantai ${o.floor} Ruang ${o.room}.`, `#/order/${o.id}`);
  notify(ownerOfMerchant(o.merchant_id), 'Kurir sudah mengambil makanan', o.code, '#/m/orders');
  return { ok: true };
});
R('POST', '/api/courier/orders/:id/complete', COURIER, ctx => {
  const o = courierOrder(ctx);
  if (o.status !== 'DALAM_PENGANTARAN') bad('Pesanan belum dalam pengantaran', 409);
  const r = q.run("UPDATE orders SET status='SELESAI', completed_at=? WHERE id=? AND status='DALAM_PENGANTARAN'", now(), o.id);
  if (r.changes !== 1) bad('Pesanan sudah selesai', 409);
  settle(o.id);
  notify(o.customer_id, 'Pesanan selesai', `${o.code} sudah sampai. Beri rating untuk kantin dan kurir ya.`, `#/order/${o.id}`);
  notify(ctx.user.id, 'Pendapatan masuk', `+${rp(o.delivery_fee)} dari ${o.code}`, '#/c/earnings');
  return { ok: true };
});
R('GET', '/api/courier/dashboard', COURIER, ctx => {
  const cp = q.get('SELECT * FROM courier_profiles WHERE user_id=?', ctx.user.id), w = walletInfo(ctx.user.id);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const done = q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI' AND completed_at>=?", ctx.user.id, start.getTime()).n;
  const total = q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI'", ctx.user.id).n;
  const active = q.all("SELECT delivery_fee FROM orders WHERE courier_id=? AND status NOT IN('SELESAI','DIBATALKAN')", ctx.user.id);
  return { online: !!cp.online, rating_avg: cp.rating_avg, rating_count: cp.rating_count, today_done: done, total_done: total, active: active.length,
    earned_today: w.today, estimate_today: w.today + active.reduce((s, a) => s + a.delivery_fee, 0), balance: w.balance };
});
R('GET', '/api/wallet', ['courier', 'merchant', 'admin', 'customer'], ctx => walletInfo(ctx.user.id));

/* MERCHANT */
const MERCH = ['merchant'];
R('GET', '/api/m/store', MERCH, ctx => ({ merchant: { ...merchantOf(ctx.user) }, categories: q.all('SELECT * FROM categories ORDER BY id') }));
R('PUT', '/api/m/store', MERCH, ctx => {
  const m = merchantOf(ctx.user), b = ctx.body;
  q.run('UPDATE merchants SET name=?, description=?, location=?, open=?, eta_min=? WHERE id=?',
    str(b.name, 3, 50, 'Nama kantin'), str(b.description, 0, 300, 'Deskripsi'), str(b.location || '', 0, 100, 'Lokasi'), b.open ? 1 : 0, int(b.eta_min, 3, 60, 'Estimasi'), m.id);
  return { merchant: merchantOf(ctx.user) };
});
R('GET', '/api/m/products', MERCH, ctx => ({
  products: q.all('SELECT * FROM products WHERE merchant_id=? AND deleted=0 ORDER BY id', merchantOf(ctx.user).id).map(p => productView(p)),
  categories: q.all('SELECT * FROM categories ORDER BY id'),
}));
function readProduct(b) {
  const out = {
    name: str(b.name, 2, 60, 'Nama menu'), description: str(b.description || '', 0, 300, 'Deskripsi'),
    base_price: int(b.base_price, 500, 1000000, 'Harga'), stock: int(b.stock, 0, 9999, 'Stok'),
    active: b.active ? 1 : 0, popular: b.popular ? 1 : 0, image: b.image || 'default',
  };
  if (out.image.startsWith('data:')) {
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(out.image)) bad('Format foto harus PNG/JPG/WEBP/GIF');
    if (out.image.length > 2_500_000) bad('Ukuran foto maksimal ±1,8 MB');
  } else if (!/^[a-z]{3,10}$/.test(out.image)) bad('Foto tidak valid');
  const cat = str(b.category || 'Lainnya', 2, 30, 'Kategori');
  q.run('INSERT OR IGNORE INTO categories(name) VALUES(?)', cat);
  out.category_id = q.get('SELECT id FROM categories WHERE name=?', cat).id;
  const vs = Array.isArray(b.variants) ? b.variants : [];
  if (vs.length > 60) bad('Terlalu banyak variasi');
  out.variants = vs.map((v, i) => ({
    group_name: str(v.group_name, 1, 40, 'Nama grup variasi'), label: str(v.label, 1, 40, 'Nama pilihan'),
    price_delta: int(v.price_delta ?? 0, -100000, 100000, 'Harga tambahan'), required: v.required ? 1 : 0,
    is_default: v.is_default ? 1 : 0, show_if: v.show_if ? str(v.show_if, 3, 90, 'Syarat tampil') : null, sort: i,
  }));
  const gs = [...new Set(out.variants.map(v => v.group_name))];
  out.variants.forEach(v => { v.sort = gs.indexOf(v.group_name); });
  return out;
}
function saveProduct(mid, id, p) {
  return tx(() => {
    if (!id) id = Number(q.run('INSERT INTO products(merchant_id,category_id,name,description,base_price,image,stock,active,popular) VALUES(?,?,?,?,?,?,?,?,?)',
      mid, p.category_id, p.name, p.description, p.base_price, p.image, p.stock, p.active, p.popular).lastInsertRowid);
    else q.run('UPDATE products SET category_id=?,name=?,description=?,base_price=?,image=?,stock=?,active=?,popular=? WHERE id=?',
      p.category_id, p.name, p.description, p.base_price, p.image, p.stock, p.active, p.popular, id);
    q.run('DELETE FROM product_variants WHERE product_id=?', id);
    p.variants.forEach(v => q.run('INSERT INTO product_variants(product_id,group_name,label,price_delta,required,is_default,show_if,sort) VALUES(?,?,?,?,?,?,?,?)',
      id, v.group_name, v.label, v.price_delta, v.required, v.is_default, v.show_if, v.sort));
    return id;
  });
}
const ownProduct = (ctx, m) => q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', Number(ctx.params.id), m.id) || bad('Menu tidak ditemukan', 404);
R('POST', '/api/m/products', MERCH, ctx => {
  const m = merchantOf(ctx.user);
  return { product: productView(q.get('SELECT * FROM products WHERE id=?', saveProduct(m.id, null, readProduct(ctx.body)))) };
});
R('PUT', '/api/m/products/:id', MERCH, ctx => {
  const m = merchantOf(ctx.user), p = ownProduct(ctx, m);
  saveProduct(m.id, p.id, readProduct(ctx.body));
  return { product: productView(q.get('SELECT * FROM products WHERE id=?', p.id)) };
});
R('PATCH', '/api/m/products/:id/stock', MERCH, ctx => {
  const p = ownProduct(ctx, merchantOf(ctx.user));
  q.run('UPDATE products SET stock=? WHERE id=?', int(ctx.body.stock, 0, 9999, 'Stok'), p.id);
  return { ok: true };
});
R('PATCH', '/api/m/products/:id/active', MERCH, ctx => {
  const p = ownProduct(ctx, merchantOf(ctx.user));
  q.run('UPDATE products SET active=? WHERE id=?', ctx.body.active ? 1 : 0, p.id);
  return { ok: true };
});
R('DELETE', '/api/m/products/:id', MERCH, ctx => {
  const p = ownProduct(ctx, merchantOf(ctx.user));
  tx(() => { q.run('UPDATE products SET deleted=1, active=0 WHERE id=?', p.id); q.run('DELETE FROM cart_items WHERE product_id=?', p.id); q.run('DELETE FROM favorites WHERE product_id=?', p.id); q.run('UPDATE vouchers SET active=0 WHERE product_id=?', p.id); });
  return { ok: true };
});
R('GET', '/api/m/orders', MERCH, ctx => {
  const m = merchantOf(ctx.user);
  const rows = q.all("SELECT * FROM orders WHERE merchant_id=? AND status!='MENUNGGU_PEMBAYARAN' AND NOT (status='DIBATALKAN' AND paid_at IS NULL AND type='online') ORDER BY id DESC LIMIT 150", m.id);
  return { orders: rows.map(o => orderView(o, ctx.user)) };
});
function merchOrder(ctx) {
  const m = merchantOf(ctx.user);
  const o = q.get("SELECT * FROM orders WHERE id=? AND merchant_id=? AND type='online'", Number(ctx.params.id), m.id) || bad('Pesanan tidak ditemukan', 404);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Pesanan tidak bisa diubah', 409);
  return o;
}
R('POST', '/api/m/orders/:id/accept', MERCH, ctx => {
  const o = merchOrder(ctx);
  if (o.food_state !== 0) bad('Pesanan sudah diterima', 409);
  q.run('UPDATE orders SET food_state=1 WHERE id=?', o.id); refresh(o.id);
  notify(o.customer_id, 'Pesanan diterima kantin', `${o.code} akan segera disiapkan.`, `#/order/${o.id}`);
  return { ok: true };
});
R('POST', '/api/m/orders/:id/reject', MERCH, ctx => {
  const o = merchOrder(ctx);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan, tidak bisa ditolak', 409);
  cancelOrder(o.id, 'Ditolak kantin: ' + str(ctx.body.reason, 3, 120, 'Alasan penolakan'), 'merchant');
  return { ok: true };
});
R('POST', '/api/m/orders/:id/prepare', MERCH, ctx => {
  const o = merchOrder(ctx);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan', 409);
  q.run('UPDATE orders SET food_state=2 WHERE id=?', o.id); refresh(o.id);
  notify(o.customer_id, 'Makanan sedang disiapkan', `${o.code} sedang dimasak.`, `#/order/${o.id}`);
  return { ok: true };
});
R('POST', '/api/m/orders/:id/ready', MERCH, ctx => {
  const o = merchOrder(ctx);
  if (o.food_state !== 2) bad('Tandai "sedang disiapkan" terlebih dahulu', 409);
  q.run('UPDATE orders SET food_state=3 WHERE id=?', o.id); refresh(o.id);
  notify(o.customer_id, 'Makanan siap diambil', `${o.code} siap diambil kurir.`, `#/order/${o.id}`);
  notify(o.courier_id, 'Makanan siap diambil', `${o.code} sudah siap di kantin.`, '#/c/active');
  return { ok: true };
});
R('POST', '/api/m/offline', MERCH, ctx => {
  const m = merchantOf(ctx.user), items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) bad('Pilih minimal satu menu');
  const id = tx(() => {
    let subtotal = 0; const lines = [];
    for (const it of items) {
      const p = q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', Number(it.product_id), m.id) || bad('Menu tidak ditemukan', 404);
      const qty = int(it.qty, 1, 50, 'Jumlah');
      const pr = priceItem(p, it.options && Object.keys(it.options).length ? it.options : defaultOptions(p));
      reserveStock(p.id, qty); subtotal += pr.unit * qty; lines.push({ p, qty, pr });
    }
    const t = now();
    const oid = Number(q.run("INSERT INTO orders(code,merchant_id,type,status,food_state,subtotal,delivery_fee,discount,total,recipient,created_at,paid_at,completed_at,settled) VALUES(?,?,'offline','SELESAI',3,?,0,0,?,?,?,?,?,1)",
      newCode().replace('CE-', 'OFF-'), m.id, subtotal, subtotal, String(ctx.body.note || 'Pembeli offline').slice(0, 60), t, t, t).lastInsertRowid);
    lines.forEach(l => {
      q.run('INSERT INTO order_items(order_id,product_id,name,options_text,options_json,qty,unit_price) VALUES(?,?,?,?,?,?,?)', oid, l.p.id, l.p.name, l.pr.text, JSON.stringify(l.pr.sel), l.qty, l.pr.unit);
      q.run('UPDATE products SET sold=sold+? WHERE id=?', l.qty, l.p.id);
    });
    return oid;
  });
  return { order: orderView(q.get('SELECT * FROM orders WHERE id=?', id), ctx.user) };
});
R('GET', '/api/m/report', MERCH, ctx => report(ctx.query.mode === 'monthly' ? 'monthly' : 'daily', merchantOf(ctx.user).id));
R('GET', '/api/m/dashboard', MERCH, ctx => {
  const m = merchantOf(ctx.user), w = walletInfo(ctx.user.id);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todayRows = q.get("SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) s FROM orders WHERE merchant_id=? AND status='SELESAI' AND COALESCE(completed_at,created_at)>=?", m.id, start.getTime());
  return {
    merchant: { ...m, open: !!m.open }, wallet: { balance: w.balance, today: w.today, month: w.month },
    today_orders: todayRows.n, today_sales: todayRows.s,
    pending: q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state=0 AND status NOT IN('MENUNGGU_PEMBAYARAN','SELESAI','DIBATALKAN')", m.id).n,
    processing: q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state IN(1,2,3) AND status NOT IN('SELESAI','DIBATALKAN')", m.id).n,
    low_stock: q.all('SELECT name,stock FROM products WHERE merchant_id=? AND deleted=0 AND active=1 AND stock<=5 ORDER BY stock', m.id),
    chart: report('daily', m.id),
  };
});

/* ADMIN */
const ADMIN = ['admin'];
R('GET', '/api/admin/overview', ADMIN, () => {
  const c = (sql, ...a) => q.get(sql, ...a).n;
  const admin = q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  return {
    customers: c("SELECT COUNT(*) n FROM users WHERE role='customer' AND deleted=0"),
    couriers: c("SELECT COUNT(*) n FROM users WHERE role='courier' AND deleted=0"),
    couriers_online: c("SELECT COUNT(*) n FROM courier_profiles cp JOIN users u ON u.id=cp.user_id WHERE cp.online=1 AND u.active=1 AND u.deleted=0"),
    merchants: c("SELECT COUNT(*) n FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.deleted=0"),
    orders: c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('MENUNGGU_PEMBAYARAN') AND NOT(status='DIBATALKAN' AND paid_at IS NULL)"),
    orders_active: c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')"),
    transactions: c("SELECT COUNT(*) n FROM payments WHERE status IN('PAID','REFUNDED')"),
    gross: q.get("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='SELESAI'").n,
    platform_balance: walletInfo(admin.id).balance, complaints_open: c("SELECT COUNT(*) n FROM complaints WHERE status='baru'"),
    chart: report('daily', null),
  };
});
R('GET', '/api/admin/users', ADMIN, ctx => {
  const { role, q: qs, status } = ctx.query;
  let sql = `SELECT u.id,u.username,u.name,u.phone,u.role,u.active,u.created_at,
    (SELECT online FROM courier_profiles WHERE user_id=u.id) online, (SELECT rating_avg FROM courier_profiles WHERE user_id=u.id) rating,
    (SELECT name FROM merchants WHERE owner_id=u.id) store,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id OR o.courier_id=u.id OR o.merchant_id=(SELECT id FROM merchants WHERE owner_id=u.id)) orders
    FROM users u WHERE u.deleted=0`;
  const a = [];
  if (role) { sql += ' AND u.role=?'; a.push(role); }
  if (status === 'active') sql += ' AND u.active=1'; if (status === 'inactive') sql += ' AND u.active=0';
  if (qs) { sql += ' AND (u.username LIKE ? OR u.name LIKE ?)'; a.push(`%${qs}%`, `%${qs}%`); }
  return { users: q.all(sql + ' ORDER BY u.id', ...a) };
});
function targetUser(ctx) {
  const u = q.get('SELECT * FROM users WHERE id=? AND deleted=0', Number(ctx.params.id)) || bad('Pengguna tidak ditemukan', 404);
  if (u.role === 'admin') bad('Akun admin tidak bisa diubah dari sini', 403);
  return u;
}
const hasActiveOrders = u => q.get(`SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN') AND (customer_id=? OR courier_id=? OR merchant_id=(SELECT id FROM merchants WHERE owner_id=?))`, u.id, u.id, u.id).n > 0;
R('POST', '/api/admin/users/:id/active', ADMIN, ctx => {
  const u = targetUser(ctx), on = ctx.body.active ? 1 : 0;
  if (!on && hasActiveOrders(u)) bad('Pengguna masih memiliki pesanan berjalan', 409);
  q.run('UPDATE users SET active=? WHERE id=?', on, u.id);
  if (!on) { q.run('DELETE FROM sessions WHERE user_id=?', u.id); q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id); }
  notify(u.id, on ? 'Akun diaktifkan kembali' : 'Akun dinonaktifkan', on ? 'Kamu bisa menggunakan Campus Eats lagi.' : 'Hubungi admin untuk informasi lebih lanjut.');
  return { ok: true };
});
R('DELETE', '/api/admin/users/:id', ADMIN, ctx => {
  const u = targetUser(ctx);
  if (u.role === 'customer') bad('Akun pembeli cukup dinonaktifkan, tidak dihapus', 403);
  if (hasActiveOrders(u)) bad('Pengguna masih memiliki pesanan berjalan', 409);
  tx(() => {
    q.run("UPDATE users SET deleted=1, active=0, username=username||'#del'||id WHERE id=?", u.id);
    q.run('DELETE FROM sessions WHERE user_id=?', u.id);
    q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id);
    q.run('UPDATE merchants SET open=0 WHERE owner_id=?', u.id);
  });
  return { ok: true };
});
R('GET', '/api/admin/orders', ADMIN, ctx => {
  let sql = `SELECT o.*, m.name merchant_name, (SELECT name FROM users WHERE id=o.customer_id) customer_name, (SELECT name FROM users WHERE id=o.courier_id) courier_name FROM orders o JOIN merchants m ON m.id=o.merchant_id WHERE 1=1`;
  const a = [];
  if (ctx.query.status) { sql += ' AND o.status=?'; a.push(ctx.query.status); }
  if (ctx.query.q) { sql += ' AND o.code LIKE ?'; a.push(`%${ctx.query.q}%`); }
  return { orders: q.all(sql + ' ORDER BY o.id DESC LIMIT 200', ...a) };
});
R('GET', '/api/admin/transactions', ADMIN, () => ({
  payments: q.all('SELECT p.*, o.code FROM payments p JOIN orders o ON o.id=p.order_id ORDER BY p.id DESC LIMIT 200'),
  wallet: q.all(`SELECT wt.*, u.name user_name, u.role FROM wallet_transactions wt JOIN wallets w ON w.id=wt.wallet_id JOIN users u ON u.id=w.user_id WHERE wt.type!='refund' ORDER BY wt.id DESC LIMIT 200`),
}));
R('GET', '/api/admin/report', ADMIN, ctx => ({
  ...report(ctx.query.mode === 'monthly' ? 'monthly' : 'daily', null),
  complaints: q.all('SELECT c.*, u.name user_name, u.role, o.code FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN orders o ON o.id=c.order_id ORDER BY c.id DESC LIMIT 100'),
}));
R('POST', '/api/admin/complaints/:id/resolve', ADMIN, ctx => {
  q.run("UPDATE complaints SET status='selesai' WHERE id=?", Number(ctx.params.id)); return { ok: true };
});
R('GET', '/api/admin/settings', ADMIN, () => ({
  fees: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(f => [f, feeFor(f)])), commission_pct: Number(setting('commission_pct')),
  offer_timeout_sec: Number(setting('offer_timeout_sec')), payment_timeout_sec: Number(setting('payment_timeout_sec')),
  vouchers: q.all('SELECT * FROM vouchers ORDER BY rowid'),
}));
R('PUT', '/api/admin/settings', ADMIN, ctx => {
  const b = ctx.body;
  tx(() => {
    for (let f = 1; f <= 9; f++) q.run('UPDATE settings SET value=? WHERE key=?', String(int(b.fees?.[f], 0, 50000, `Ongkir lantai ${f}`)), 'fee_' + f);
    q.run("UPDATE settings SET value=? WHERE key='commission_pct'", String(int(b.commission_pct, 0, 50, 'Komisi')));
    q.run("UPDATE settings SET value=? WHERE key='offer_timeout_sec'", String(int(b.offer_timeout_sec, 10, 120, 'Batas waktu kurir')));
    q.run("UPDATE settings SET value=? WHERE key='payment_timeout_sec'", String(int(b.payment_timeout_sec, 60, 1800, 'Batas waktu bayar')));
  });
  return { ok: true };
});
R('POST', '/api/admin/vouchers', ADMIN, ctx => {
  const b = ctx.body, code = str(b.code, 3, 20, 'Kode').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) bad('Kode hanya huruf & angka');
  if (q.get('SELECT 1 x FROM vouchers WHERE code=?', code)) bad('Kode sudah ada', 409);
  const type = ['fixed', 'free_shipping', 'percent'].includes(b.type) ? b.type : bad('Tipe voucher tidak valid');
  q.run('INSERT INTO vouchers(code,description,type,value,min_subtotal,product_id) VALUES(?,?,?,?,?,?)', code, str(b.description, 3, 120, 'Deskripsi'), type,
    int(b.value ?? 0, 0, type === 'percent' ? 100 : 100000, 'Nilai'), int(b.min_subtotal ?? 0, 0, 1000000, 'Minimal belanja'), b.product_id ? Number(b.product_id) : null);
  return { ok: true };
});
R('POST', '/api/admin/vouchers/:code/toggle', ADMIN, ctx => {
  q.run('UPDATE vouchers SET active=1-active WHERE code=?', ctx.params.code); return { ok: true };
});

/* ---------- dispatcher ---------- */
async function handle(req, res, url, body) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
  const token = cookies.ce_sid;
  const sess = token && q.get('SELECT user_id FROM sessions WHERE token=? AND expires_at>?', token, now());
  const user = sess ? q.get('SELECT * FROM users WHERE id=? AND deleted=0', sess.user_id) : null;
  const ctx = { user: user && user.active ? user : null, token, body, query: Object.fromEntries(url.searchParams), params: {}, ip: req.socket.remoteAddress };
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
    if (r.roles) {
      if (!ctx.user) bad('Silakan login terlebih dahulu', 401);
      if (!r.roles.includes(ctx.user.role)) bad('Kamu tidak punya akses ke fitur ini', 403);
    }
    const data = await r.fn(ctx);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (ctx.setCookie) headers['Set-Cookie'] = ctx.setCookie;
    res.writeHead(200, headers);
    return res.end(JSON.stringify(data));
  }
  bad('Endpoint tidak ditemukan', 404);
}

module.exports = { handle, tick, HttpError };
