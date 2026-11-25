const crypto = require('crypto');
const { q, tx, now, hashPw, verifyPw, createUser } = require('./db');
const payment = require('./payment');

/* ---------- util ---------- */
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
const setting = async k => (await q.get('SELECT value FROM settings WHERE key=?', k))?.value;
const feeFor = async f => Number(await setting('fee_' + f));
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
const notify = async (uid, title, body, link) => {
  if (uid) {
    await q.run(
      'INSERT INTO notifications(user_id,title,body,link,created_at) VALUES(?,?,?,?,?)',
      uid, title, body ?? null, link ?? null, now()
    );
  }
};
const notifyAdmins = async (title, body, link) => {
  const admins = await q.all("SELECT id FROM users WHERE role='admin' AND deleted=0");
  for (const a of admins) await notify(a.id, title, body, link);
};
const merchantOf = async u => (await q.get('SELECT * FROM merchants WHERE owner_id=?', u.id)) || bad('Toko belum tersedia', 404);
const ownerOfMerchant = async id => (await q.get('SELECT owner_id FROM merchants WHERE id=?', id))?.owner_id;

async function credit(userId, amount, type, desc, orderId) {
  const w = await q.get('SELECT id FROM wallets WHERE user_id=?', userId);
  await q.run('UPDATE wallets SET balance=balance+? WHERE id=?', amount, w.id);
  await q.run(
    'INSERT INTO wallet_transactions(wallet_id,order_id,type,amount,description,created_at) VALUES(?,?,?,?,?,?)',
    w.id, orderId ?? null, type, amount, desc, now()
  );
}

async function newCode() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  for (;;) {
    const c = `CE-${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${crypto.randomInt(1000, 9999)}`;
    if (!(await q.get('SELECT 1 x FROM orders WHERE code=?', c))) return c;
  }
}

/* ---------- harga & variasi ---------- */
function variantsOf(pid) {
  return q.all('SELECT * FROM product_variants WHERE product_id=? ORDER BY sort,id', pid);
}
function groupsOf(vs) {
  const map = new Map();
  vs.forEach(v => {
    if (!map.has(v.group_name)) map.set(v.group_name, []);
    map.get(v.group_name).push(v);
  });
  return [...map.entries()].map(([name, items]) => ({
    name,
    items,
    required: items.some(i => i.required),
    show_if: items[0].show_if,
  }));
}
async function priceItem(p, opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  let unit = p.base_price;
  const sel = {};
  for (const g of groupsOf(await variantsOf(p.id))) {
    if (g.show_if) {
      const [k, val] = g.show_if.split('=');
      if (opts[k] !== val) continue;
    }
    const pick = opts[g.name];
    if (!pick) {
      if (g.required) bad(`Pilih ${g.name} terlebih dahulu`);
      continue;
    }
    const v = g.items.find(i => i.label === pick) || bad(`Pilihan ${g.name} tidak valid`);
    unit += v.price_delta;
    sel[g.name] = pick;
  }
  return { unit, sel, text: Object.entries(sel).map(([g, l]) => `${g}: ${l}`).join(', ') };
}
async function defaultOptions(p) {
  const opts = {};
  for (const g of groupsOf(await variantsOf(p.id))) {
    if (g.show_if) {
      const [k, val] = g.show_if.split('=');
      if (opts[k] !== val) continue;
    }
    const d = g.items.find(i => i.is_default) || g.items[0];
    opts[g.name] = d.label;
  }
  return opts;
}
async function productView(p, uid) {
  const cat = await q.get('SELECT name FROM categories WHERE id=?', p.category_id);
  const fav = uid ? !!(await q.get('SELECT 1 x FROM favorites WHERE user_id=? AND product_id=?', uid, p.id)) : false;
  const vs = await variantsOf(p.id);
  return {
    ...p,
    active: !!p.active,
    popular: !!p.popular,
    category: cat?.name,
    available: !!p.active && p.stock > 0,
    fav,
    groups: groupsOf(vs).map(g => ({
      name: g.name,
      required: g.required,
      show_if: g.show_if,
      items: g.items.map(i => ({ label: i.label, price_delta: i.price_delta, is_default: !!i.is_default })),
    })),
  };
}

/* ---------- voucher ---------- */
async function applyVoucher(code, items, subtotal, fee) {
  if (!code) return { discount: 0, voucher: null };
  const v = (await q.get('SELECT * FROM vouchers WHERE code=? AND active=1', String(code).trim()))
    || bad('Voucher tidak ditemukan atau tidak aktif');
  if (subtotal < v.min_subtotal) bad(`Voucher ${v.code} butuh belanja minimal ${rp(v.min_subtotal)}`);
  if (v.product_id && !items.some(i => i.product_id === v.product_id)) bad(`Voucher ${v.code} hanya berlaku untuk menu tertentu`);
  let d = v.type === 'free_shipping'
    ? (v.value > 0 ? Math.min(fee, v.value) : fee)
    : v.type === 'percent' ? Math.floor(subtotal * v.value / 100) : v.value;
  d = Math.max(0, Math.min(d, subtotal + fee));
  return { discount: d, voucher: v.code };
}

/* ---------- stok ---------- */
async function reserveStock(productId, qty) {
  const r = await q.run('UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1 AND deleted=0', qty, productId, qty);
  if (r.changes !== 1) {
    const p = await q.get('SELECT name,stock FROM products WHERE id=?', productId);
    bad(`Stok ${p?.name || 'menu'} tidak mencukupi${p ? ` (tersisa ${p.stock})` : ''}`, 409);
  }
}
async function releaseStock(orderId) {
  const items = await q.all('SELECT product_id,qty FROM order_items WHERE order_id=?', orderId);
  for (const i of items) {
    await q.run('UPDATE products SET stock=stock+? WHERE id=?', i.qty, i.product_id);
  }
}

/* ---------- status pesanan ---------- */
async function refresh(id) {
  const o = await q.get('SELECT * FROM orders WHERE id=?', id);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') return o;
  let s;
  if (o.delivery_stage === 2) s = 'DALAM_PENGANTARAN';
  else if (o.delivery_stage === 1) s = 'KURIR_MENGAMBIL';
  else if (o.food_state === 3) s = 'SIAP_DIAMBIL';
  else if (o.food_state === 2) s = 'SEDANG_DISIAPKAN';
  else if (o.courier_id) s = o.food_state === 1 ? 'MENUNGGU_DISIAPKAN' : 'KURIR_DITEMUKAN';
  else s = 'MENCARI_KURIR';
  if (s !== o.status) await q.run('UPDATE orders SET status=? WHERE id=?', s, id);
  return { ...o, status: s };
}

async function markPaid(orderId) {
  const o = await tx(async () => {
    const r = await q.run("UPDATE orders SET status='PEMBAYARAN_BERHASIL', paid_at=? WHERE id=? AND status='MENUNGGU_PEMBAYARAN'", now(), orderId);
    if (r.changes !== 1) bad('Pesanan tidak dalam status menunggu pembayaran', 409);
    await q.run("UPDATE payments SET status='PAID', paid_at=? WHERE order_id=? AND status='PENDING'", now(), orderId);
    const updated = await refresh(orderId);
    await notify(updated.customer_id, 'Pembayaran berhasil', `Pesanan ${updated.code} sedang dicarikan kurir.`, `#/order/${updated.id}`);
    await notify(await ownerOfMerchant(updated.merchant_id), 'Pesanan online baru', `${updated.code} - ${rp(updated.subtotal)}. Segera terima pesanan.`, '#/m/orders');
    await notifyAdmins('Transaksi baru', `${updated.code} senilai ${rp(updated.total)}`, '#/a/transactions');
    return updated;
  });
  await dispatch(o.id);
}

async function cancelOrder(id, reason) {
  return tx(async () => {
    const o = await q.get('SELECT * FROM orders WHERE id=?', id);
    if (!o || TERMINAL.includes(o.status)) bad('Pesanan tidak bisa dibatalkan', 409);
    const paid = o.status !== 'MENUNGGU_PEMBAYARAN';
    await q.run("UPDATE orders SET status='DIBATALKAN', cancel_reason=?, courier_search='' WHERE id=?", reason, id);
    await q.run("UPDATE deliveries SET status='cancelled', responded_at=? WHERE order_id=? AND status IN('offered','accepted')", now(), id);
    await releaseStock(id);
    await q.run("UPDATE payments SET status=? WHERE order_id=? AND status IN('PENDING','PAID')", paid ? 'REFUNDED' : 'CANCELLED', id);
    if (paid && o.customer_id) await credit(o.customer_id, o.total, 'refund', `Refund pesanan ${o.code}`, id);
    await notify(o.customer_id, 'Pesanan dibatalkan', `${o.code}: ${reason}${paid ? `. Saldo refund ${rp(o.total)} sudah masuk.` : ''}`, `#/order/${id}`);
    if (paid) await notify(await ownerOfMerchant(o.merchant_id), 'Pesanan dibatalkan', `${o.code}: ${reason}`, '#/m/orders');
    if (o.courier_id) await notify(o.courier_id, 'Pesanan dibatalkan', `${o.code} dibatalkan: ${reason}`, '#/c/active');
    return q.get('SELECT * FROM orders WHERE id=?', id);
  });
}

/* ---------- pencarian kurir ---------- */
const activeJobs = "(SELECT COUNT(*) FROM orders x WHERE x.courier_id=u.id AND x.status NOT IN('SELESAI','DIBATALKAN'))";
async function dispatch(orderId) {
  const o = await q.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o || o.type !== 'online' || o.courier_id || o.status === 'MENUNGGU_PEMBAYARAN' || TERMINAL.includes(o.status)) return;
  if (await q.get("SELECT 1 x FROM deliveries WHERE order_id=? AND status='offered'", orderId)) return;
  const c = await q.get(
    `SELECT u.id FROM users u JOIN courier_profiles cp ON cp.user_id=u.id
    WHERE u.role='courier' AND u.active=1 AND u.deleted=0 AND cp.online=1
      AND u.id NOT IN (SELECT courier_id FROM deliveries WHERE order_id=?)
      AND u.id NOT IN (SELECT courier_id FROM deliveries WHERE status='offered')
      AND ${activeJobs} < 2
    ORDER BY ${activeJobs} ASC, cp.last_offer_at ASC, u.id ASC LIMIT 1`,
    orderId
  );
  if (!c) {
    if (o.courier_search !== 'none') {
      await q.run("UPDATE orders SET courier_search='none' WHERE id=?", orderId);
      await notify(o.customer_id, 'Belum ada kurir tersedia', 'Kamu bisa menunggu atau membatalkan pesanan dengan refund.', `#/order/${orderId}`);
    }
    return;
  }
  const t = now();
  const timeoutSec = Number(await setting('offer_timeout_sec'));
  await q.run(
    "INSERT INTO deliveries(order_id,courier_id,status,offered_at,expires_at) VALUES(?,?,'offered',?,?)",
    orderId, c.id, t, t + timeoutSec * 1000
  );
  await q.run('UPDATE courier_profiles SET last_offer_at=? WHERE user_id=?', t, c.id);
  if (o.courier_search) await q.run("UPDATE orders SET courier_search='' WHERE id=?", orderId);
  await notify(c.id, 'Pesanan baru!', `${rp(o.delivery_fee)} - Lantai ${o.floor}, Ruang ${o.room}`, '#/c/available');
}

async function tick() {
  try {
    const t = now();
    const expiredOffers = await q.all("SELECT id,order_id FROM deliveries WHERE status='offered' AND expires_at<?", t);
    for (const d of expiredOffers) {
      await q.run("UPDATE deliveries SET status='expired', responded_at=? WHERE id=?", t, d.id);
      await dispatch(d.order_id);
    }
    const waitingOrders = await q.all("SELECT id FROM orders WHERE type='online' AND courier_id IS NULL AND status NOT IN('MENUNGGU_PEMBAYARAN','SELESAI','DIBATALKAN')");
    for (const o of waitingOrders) await dispatch(o.id);

    const limit = t - Number(await setting('payment_timeout_sec')) * 1000;
    const unpaidOrders = await q.all("SELECT id FROM orders WHERE status='MENUNGGU_PEMBAYARAN' AND created_at<?", limit);
    for (const o of unpaidOrders) {
      try { await cancelOrder(o.id, 'Waktu pembayaran habis'); } catch {}
    }
    await q.run('DELETE FROM sessions WHERE expires_at<?', t);
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

async function settle(orderId) {
  await tx(async () => {
    const r = await q.run("UPDATE orders SET settled=1 WHERE id=? AND settled=0 AND status='SELESAI'", orderId);
    if (r.changes !== 1) return;
    const o = await q.get('SELECT * FROM orders WHERE id=?', orderId);
    const pct = Number(await setting('commission_pct')) || 0;
    const commission = Math.round(o.subtotal * pct / 100);
    await credit(await ownerOfMerchant(o.merchant_id), o.subtotal - commission, 'sale', `Penjualan ${o.code}`, orderId);
    await credit(o.courier_id, o.delivery_fee, 'delivery_fee', `Ongkir ${o.code}`, orderId);
    const admin = await q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
    if (admin) {
      if (commission) await credit(admin.id, commission, 'commission', `Komisi ${o.code}`, orderId);
      if (o.discount) await credit(admin.id, -o.discount, 'voucher', `Subsidi voucher ${o.voucher_code || ''} ${o.code}`, orderId);
    }
    const items = await q.all('SELECT product_id,qty FROM order_items WHERE order_id=?', orderId);
    for (const i of items) await q.run('UPDATE products SET sold=sold+? WHERE id=?', i.qty, i.product_id);
  });
}

/* ---------- serializer ---------- */
async function orderView(o, viewer) {
  const items = await q.all('SELECT * FROM order_items WHERE order_id=?', o.id);
  const m = await q.get('SELECT id,name,location,eta_min FROM merchants WHERE id=?', o.merchant_id);
  const courier = o.courier_id
    ? await q.get('SELECT u.id,u.name,u.phone,cp.rating_avg,cp.rating_count FROM users u JOIN courier_profiles cp ON cp.user_id=u.id WHERE u.id=?', o.courier_id)
    : null;
  const pay = await q.get('SELECT method,provider,ref,status FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id);
  const customer = o.customer_id ? await q.get('SELECT name,phone FROM users WHERE id=?', o.customer_id) : null;
  const rated = !!(await q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id));
  const payTimeout = Number(await setting('payment_timeout_sec'));
  const view = {
    ...o,
    merchant: m,
    courier,
    payment: pay,
    rated,
    items,
    customer: viewer?.role === 'customer' ? undefined : customer,
    eta: m ? m.eta_min + Math.ceil((o.floor || 1) / 2) + 2 : null,
    payment_expires_at: o.status === 'MENUNGGU_PEMBAYARAN' ? o.created_at + payTimeout * 1000 : null,
  };
  if (viewer?.role === 'courier') {
    delete view.subtotal;
    delete view.discount;
    delete view.total;
  }
  return view;
}

async function canSee(user, o) {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return o.customer_id === user.id;
  if (user.role === 'merchant') return (await ownerOfMerchant(o.merchant_id)) === user.id;
  if (user.role === 'courier') return o.courier_id === user.id;
  return false;
}

/* ---------- laporan ---------- */
async function report(mode, merchantId) {
  const days = mode === 'monthly' ? 6 : 14;
  const keys = [];
  const labels = [];
  const d = new Date();
  d.setDate(1);
  for (let i = days - 1; i >= 0; i--) {
    const x = mode === 'monthly' ? new Date(d.getFullYear(), d.getMonth() - i, 1) : new Date(Date.now() - i * 86400000);
    const p = n => String(n).padStart(2, '0');
    keys.push(mode === 'monthly' ? `${x.getFullYear()}-${p(x.getMonth() + 1)}` : `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`);
    labels.push(mode === 'monthly' ? x.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' }) : x.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }));
  }
  const fmt = mode === 'monthly' ? '%Y-%m' : '%Y-%m-%d';
  const rows = await q.all(
    `SELECT strftime('${fmt}', COALESCE(completed_at,created_at)/1000,'unixepoch','localtime') k, type, COUNT(*) n, SUM(subtotal) s, SUM(delivery_fee) f
    FROM orders WHERE status='SELESAI' ${merchantId ? 'AND merchant_id=?' : ''} GROUP BY k,type`,
    ...(merchantId ? [merchantId] : [])
  );
  const out = { labels, online: keys.map(() => 0), offline: keys.map(() => 0), orders: keys.map(() => 0), fees: keys.map(() => 0) };
  rows.forEach(r => {
    const i = keys.indexOf(r.k);
    if (i < 0) return;
    out[r.type][i] += r.s;
    out.orders[i] += r.n;
    out.fees[i] += r.f || 0;
  });
  out.total = out.online.reduce((a, b) => a + b, 0) + out.offline.reduce((a, b) => a + b, 0);
  out.count = out.orders.reduce((a, b) => a + b, 0);
  return out;
}

async function walletInfo(uid) {
  const w = await q.get('SELECT * FROM wallets WHERE user_id=?', uid);
  const sum = async since => (await q.get(
    "SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions WHERE wallet_id=? AND amount>0 AND type!='refund' AND created_at>=?",
    w.id, since
  )).s;
  const d = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return {
    balance: w.balance,
    today: await sum(day),
    month: await sum(month),
    transactions: await q.all('SELECT * FROM wallet_transactions WHERE wallet_id=? ORDER BY id DESC LIMIT 100', w.id),
  };
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
const cookieOpts = age => `; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}`;
R('POST', '/api/auth/login', ANY, async ctx => {
  const username = String(ctx.body.username || '').trim();
  const key = ctx.ip + '|' + username.toLowerCase();
  const f = fails.get(key);
  if (f && f.n >= 5 && now() - f.t < 600000) bad('Terlalu banyak percobaan login. Coba lagi dalam 10 menit.', 429);
  const u = await q.get('SELECT * FROM users WHERE username=? AND deleted=0', username);
  if (!u || !(await verifyPw(String(ctx.body.password || ''), u.password_hash))) {
    fails.set(key, { n: (f && now() - f.t < 600000 ? f.n : 0) + 1, t: now() });
    bad('Username atau password salah', 401);
  }
  if (!u.active) bad('Akun dinonaktifkan. Hubungi admin Campus Eats.', 403);
  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  await q.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, u.id, now() + 7 * 864e5);
  ctx.setCookie = `ce_sid=${token}${cookieOpts(7 * 86400)}`;
  return { user: await publicUser(u) };
});

R('POST', '/api/auth/logout', ANY, async ctx => {
  if (ctx.token) await q.run('DELETE FROM sessions WHERE token=?', ctx.token);
  ctx.setCookie = `ce_sid=${cookieOpts(0)}`;
  return { ok: true };
});

R('POST', '/api/auth/register', ANY, async ctx => {
  const b = ctx.body;
  const role = ['customer', 'courier', 'merchant'].includes(b.role) ? b.role : bad('Jenis akun tidak valid');
  const username = String(b.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) bad('Username 3-20 karakter (huruf, angka, underscore)');
  const password = String(b.password || '');
  if (password.length < 6 || password.length > 72) bad('Password minimal 6 karakter');
  const name = str(b.name, 2, 60, 'Nama');
  const phone = b.phone ? str(b.phone, 8, 16, 'No. HP') : null;
  if (phone && !/^[0-9+]+$/.test(phone)) bad('No. HP hanya boleh berisi angka');
  if (await q.get('SELECT 1 x FROM users WHERE username=?', username)) bad('Username sudah dipakai', 409);
  const id = await tx(async () => {
    const newId = await createUser({ username, password, role, name, phone });
    if (role === 'merchant') {
      await q.run(
        'INSERT INTO merchants(owner_id,name,description,open) VALUES(?,?,?,0)',
        newId, str(b.store_name || name, 3, 50, 'Nama kantin'), 'Kantin baru di Campus Eats.'
      );
    }
    await notifyAdmins(
      role === 'courier' ? 'Kurir baru' : role === 'merchant' ? 'Kantin baru' : 'Pengguna baru',
      `${name} (@${username}) mendaftar`,
      '#/a/users'
    );
    return newId;
  });
  const token = crypto.randomBytes(32).toString('hex');
  await q.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, id, now() + 7 * 864e5);
  ctx.setCookie = `ce_sid=${token}${cookieOpts(7 * 86400)}`;
  return { user: await publicUser(await q.get('SELECT * FROM users WHERE id=?', id)) };
});

async function publicUser(u) {
  const out = { id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone };
  if (u.role === 'customer') {
    Object.assign(out, await q.get('SELECT default_floor,default_room FROM customer_profiles WHERE user_id=?', u.id));
    out.refund_balance = (await q.get('SELECT balance FROM wallets WHERE user_id=?', u.id)).balance;
  }
  if (u.role === 'courier') {
    Object.assign(out, await q.get('SELECT online,rating_avg,rating_count FROM courier_profiles WHERE user_id=?', u.id));
  }
  if (u.role === 'merchant') {
    out.merchant = await q.get('SELECT * FROM merchants WHERE owner_id=?', u.id);
  }
  return out;
}

R('GET', '/api/me', ANY, async ctx => ({ user: ctx.user ? await publicUser(ctx.user) : null }));

R('PUT', '/api/profile', ['customer', 'courier', 'merchant', 'admin'], async ctx => {
  const b = ctx.body;
  const u = ctx.user;
  const name = str(b.name, 2, 60, 'Nama');
  const phone = b.phone ? str(b.phone, 8, 16, 'No. HP') : null;
  if (phone && !/^[0-9+]+$/.test(phone)) bad('No. HP hanya boleh berisi angka');
  await q.run('UPDATE users SET name=?, phone=? WHERE id=?', name, phone, u.id);
  if (u.role === 'customer') {
    const f = b.default_floor ? int(b.default_floor, 1, 9, 'Lantai') : null;
    const r = b.default_room ? int(b.default_room, 101, 120, 'Ruang') : null;
    await q.run('UPDATE customer_profiles SET default_floor=?, default_room=? WHERE user_id=?', f, r, u.id);
  }
  return { user: await publicUser(await q.get('SELECT * FROM users WHERE id=?', u.id)) };
});

R('POST', '/api/profile/password', ['customer', 'courier', 'merchant', 'admin'], async ctx => {
  if (!(await verifyPw(String(ctx.body.current || ''), ctx.user.password_hash))) bad('Password lama salah');
  const n = String(ctx.body.next || '');
  if (n.length < 6 || n.length > 72) bad('Password baru minimal 6 karakter');
  await q.run('UPDATE users SET password_hash=? WHERE id=?', await hashPw(n), ctx.user.id);
  return { ok: true };
});

/* NOTIFIKASI */
R('GET', '/api/notifications', ANY, async ctx => {
  if (!ctx.user) bad('Silakan login', 401);
  return {
    items: await q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', ctx.user.id),
    unread: (await q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', ctx.user.id)).c,
  };
});

R('POST', '/api/notifications/read', ANY, async ctx => {
  if (!ctx.user) bad('Silakan login', 401);
  await q.run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id);
  return { ok: true };
});

R('POST', '/api/complaints', ['customer', 'courier', 'merchant'], async ctx => {
  const b = ctx.body;
  let oid = null;
  if (b.order_id) {
    const o = await q.get('SELECT * FROM orders WHERE id=?', Number(b.order_id));
    if (!o || !(await canSee(ctx.user, o))) bad('Pesanan tidak ditemukan', 404);
    oid = o.id;
  }
  await q.run(
    'INSERT INTO complaints(user_id,order_id,subject,message,created_at) VALUES(?,?,?,?,?)',
    ctx.user.id, oid, str(b.subject, 3, 80, 'Judul'), str(b.message, 5, 1000, 'Pesan'), now()
  );
  await notifyAdmins('Pengaduan baru', `${ctx.user.name}: ${String(b.subject).slice(0, 60)}`, '#/a/reports');
  return { ok: true };
});

/* KATALOG (customer) */
R('GET', '/api/merchants', ['customer'], async () => {
  const merchants = await q.all('SELECT m.* FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.active=1 AND u.deleted=0');
  return {
    merchants: merchants.map(m => ({ ...m, open: !!m.open })),
    categories: await q.all('SELECT * FROM categories ORDER BY id'),
  };
});

R('GET', '/api/menu', ['customer'], async ctx => {
  const qs = String(ctx.query.q || '').toLowerCase();
  const cat = ctx.query.cat;
  const raw = await q.all(
    `SELECT p.* FROM products p JOIN merchants m ON m.id=p.merchant_id JOIN users u ON u.id=m.owner_id
    WHERE p.deleted=0 AND p.active=1 AND u.active=1 AND u.deleted=0 ORDER BY p.popular DESC, p.sold DESC`
  );
  let rows = await Promise.all(raw.map(p => productView(p, ctx.user.id)));
  if (cat && cat !== 'Semua') rows = rows.filter(p => p.category === cat);
  if (qs) rows = rows.filter(p => p.name.toLowerCase().includes(qs) || (p.category || '').toLowerCase().includes(qs));
  return { products: rows };
});

R('GET', '/api/products/:id', ['customer'], async ctx => {
  const p = (await q.get('SELECT * FROM products WHERE id=? AND deleted=0', Number(ctx.params.id))) || bad('Menu tidak ditemukan', 404);
  const m = await q.get('SELECT id,name,open,eta_min FROM merchants WHERE id=?', p.merchant_id);
  return { product: await productView(p, ctx.user.id), merchant: { ...m, open: !!m.open } };
});

R('GET', '/api/favorites', ['customer'], async ctx => {
  const rows = await q.all('SELECT p.* FROM products p JOIN favorites f ON f.product_id=p.id WHERE f.user_id=? AND p.deleted=0', ctx.user.id);
  return { products: await Promise.all(rows.map(p => productView(p, ctx.user.id))) };
});

R('POST', '/api/favorites/:id', ['customer'], async ctx => {
  const pid = Number(ctx.params.id);
  if (!(await q.get('SELECT 1 x FROM products WHERE id=? AND deleted=0', pid))) bad('Menu tidak ditemukan', 404);
  const has = await q.get('SELECT 1 x FROM favorites WHERE user_id=? AND product_id=?', ctx.user.id, pid);
  if (has) await q.run('DELETE FROM favorites WHERE user_id=? AND product_id=?', ctx.user.id, pid);
  else await q.run('INSERT INTO favorites(user_id,product_id) VALUES(?,?)', ctx.user.id, pid);
  return { fav: !has };
});

R('GET', '/api/fees', ['customer'], async () => {
  const entries = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(async f => [f, await feeFor(f)]));
  return {
    fees: Object.fromEntries(entries),
    vouchers: await q.all('SELECT v.*, p.name product_name FROM vouchers v LEFT JOIN products p ON p.id=v.product_id WHERE v.active=1'),
  };
});

/* KERANJANG */
async function cartView(uid) {
  const cart = await q.get('SELECT id FROM carts WHERE user_id=?', uid);
  const cartRows = await q.all('SELECT * FROM cart_items WHERE cart_id=? ORDER BY id', cart.id);
  const items = [];
  for (const ci of cartRows) {
    const p = await q.get('SELECT * FROM products WHERE id=?', ci.product_id);
    let price = { unit: p.base_price, text: '' };
    let invalid = null;
    try { price = await priceItem(p, json(ci.options)); } catch (e) { invalid = e.message; }
    if (!p.active || p.deleted) invalid = 'Menu tidak tersedia';
    else if (p.stock < ci.qty) invalid = `Stok tersisa ${p.stock}`;
    items.push({
      id: ci.id,
      qty: ci.qty,
      note: ci.note,
      options: json(ci.options),
      unit: price.unit,
      text: price.text,
      total: price.unit * ci.qty,
      invalid,
      product: { id: p.id, name: p.name, image: p.image, stock: p.stock, merchant_id: p.merchant_id },
    });
  }
  const merchant = items[0] ? await q.get('SELECT id,name,open FROM merchants WHERE id=?', items[0].product.merchant_id) : null;
  return {
    items,
    subtotal: items.reduce((s, i) => s + i.total, 0),
    count: items.reduce((s, i) => s + i.qty, 0),
    merchant,
  };
}

R('GET', '/api/cart', ['customer'], ctx => cartView(ctx.user.id));

R('POST', '/api/cart/items', ['customer'], async ctx => {
  const b = ctx.body;
  const p = (await q.get('SELECT * FROM products WHERE id=? AND deleted=0 AND active=1', Number(b.product_id))) || bad('Menu tidak tersedia', 404);
  const qty = int(b.qty ?? 1, 1, 20, 'Jumlah');
  const price = await priceItem(p, b.options);
  const cart = await q.get('SELECT id FROM carts WHERE user_id=?', ctx.user.id);
  const other = await q.get('SELECT p.merchant_id FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=? LIMIT 1', cart.id);
  if (other && other.merchant_id !== p.merchant_id) bad('Keranjang hanya bisa berisi menu dari satu kantin', 409);
  const note = b.note ? String(b.note).slice(0, 200) : null;
  const opts = JSON.stringify(price.sel);
  const same = await q.get("SELECT * FROM cart_items WHERE cart_id=? AND product_id=? AND options=? AND COALESCE(note,'')=?", cart.id, p.id, opts, note || '');
  const total = (same?.qty || 0) + qty;
  if (total > 20) bad('Maksimal 20 porsi per item');
  if (total > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409);
  if (same) await q.run('UPDATE cart_items SET qty=? WHERE id=?', total, same.id);
  else await q.run('INSERT INTO cart_items(cart_id,product_id,options,note,qty) VALUES(?,?,?,?,?)', cart.id, p.id, opts, note, qty);
  return cartView(ctx.user.id);
});

async function ownCartItem(ctx) {
  return (await q.get('SELECT ci.* FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=? AND c.user_id=?', Number(ctx.params.id), ctx.user.id))
    || bad('Item tidak ditemukan', 404);
}

R('PATCH', '/api/cart/items/:id', ['customer'], async ctx => {
  const ci = await ownCartItem(ctx);
  const b = ctx.body;
  const p = await q.get('SELECT * FROM products WHERE id=?', ci.product_id);
  const qty = b.qty !== undefined ? int(b.qty, 1, 20, 'Jumlah') : ci.qty;
  if (qty > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409);
  let opts = ci.options;
  if (b.options) opts = JSON.stringify((await priceItem(p, b.options)).sel);
  await q.run(
    'UPDATE cart_items SET qty=?, options=?, note=? WHERE id=?',
    qty, opts, b.note !== undefined ? String(b.note || '').slice(0, 200) || null : ci.note, ci.id
  );
  return cartView(ctx.user.id);
});

R('DELETE', '/api/cart/items/:id', ['customer'], async ctx => {
  const ci = await ownCartItem(ctx);
  await q.run('DELETE FROM cart_items WHERE id=?', ci.id);
  return cartView(ctx.user.id);
});

R('POST', '/api/vouchers/check', ['customer'], async ctx => {
  const cart = await cartView(ctx.user.id);
  const fee = ctx.body.floor ? await feeFor(int(ctx.body.floor, 1, 9, 'Lantai')) : 0;
  const r = await applyVoucher(ctx.body.code, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
  return { ...r, message: `Voucher ${r.voucher} dipakai, hemat ${rp(r.discount)}` };
});

/* PESANAN (customer) */
R('POST', '/api/orders', ['customer'], async ctx => {
  const b = ctx.body;
  const floor = int(b.floor, 1, 9, 'Lantai');
  const room = int(b.room, 101, 120, 'Ruang');
  const recipient = str(b.recipient, 2, 60, 'Nama penerima');
  const courierNote = b.courier_note ? String(b.courier_note).slice(0, 200) : null;
  const id = await tx(async () => {
    const cart = await cartView(ctx.user.id);
    if (!cart.items.length) bad('Keranjang masih kosong');
    const bad1 = cart.items.find(i => i.invalid);
    if (bad1) bad(`${bad1.product.name}: ${bad1.invalid}`, 409);
    const m = await q.get('SELECT m.*, u.active ua FROM merchants m JOIN users u ON u.id=m.owner_id WHERE m.id=?', cart.merchant.id);
    if (!m.open || !m.ua) bad('Kantin sedang tutup', 409);
    const fee = await feeFor(floor);
    const v = await applyVoucher(b.voucher, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
    const total = cart.subtotal + fee - v.discount;
    const code = await newCode();
    const oRes = await q.run(
      `INSERT INTO orders(code,customer_id,merchant_id,type,status,subtotal,delivery_fee,discount,total,voucher_code,floor,room,recipient,courier_note,created_at)
      VALUES(?,?,?,'online','MENUNGGU_PEMBAYARAN',?,?,?,?,?,?,?,?,?,?)`,
      code, ctx.user.id, m.id, cart.subtotal, fee, v.discount, total, v.voucher, floor, room, recipient, courierNote, now()
    );
    const oid = Number(oRes.lastInsertRowid);
    for (const i of cart.items) {
      await reserveStock(i.product.id, i.qty);
      await q.run(
        'INSERT INTO order_items(order_id,product_id,name,options_text,options_json,note,qty,unit_price) VALUES(?,?,?,?,?,?,?,?)',
        oid, i.product.id, i.product.name, i.text, JSON.stringify(i.options), i.note, i.qty, i.unit
      );
    }
    const ch = payment.createCharge({ code, total });
    await q.run("INSERT INTO payments(order_id,method,provider,ref,amount,status,created_at) VALUES(?,'QRIS',?,?,?,'PENDING',?)", oid, payment.provider, ch.ref, total, now());
    await q.run('DELETE FROM cart_items WHERE cart_id=(SELECT id FROM carts WHERE user_id=?)', ctx.user.id);
    return oid;
  });
  return { order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', id), ctx.user) };
});

R('GET', '/api/orders', ['customer'], async ctx => {
  const f = ctx.query.filter || 'all';
  let rows = await q.all('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100', ctx.user.id);
  if (f === 'berhasil') rows = rows.filter(o => o.status === 'SELESAI');
  if (f === 'dibatalkan') rows = rows.filter(o => o.status === 'DIBATALKAN');
  if (f === 'aktif') rows = rows.filter(o => !TERMINAL.includes(o.status));
  return { orders: await Promise.all(rows.map(o => orderView(o, ctx.user))) };
});

R('GET', '/api/orders/:id', ['customer', 'merchant', 'courier', 'admin'], async ctx => {
  const o = await q.get('SELECT * FROM orders WHERE id=?', Number(ctx.params.id));
  if (!o || !(await canSee(ctx.user, o))) bad('Pesanan tidak ditemukan', 404);
  return { order: await orderView(o, ctx.user) };
});

async function ownOrder(ctx) {
  const o = await q.get('SELECT * FROM orders WHERE id=? AND customer_id=?', Number(ctx.params.id), ctx.user.id);
  return o || bad('Pesanan tidak ditemukan', 404);
}

R('POST', '/api/orders/:id/pay', ['customer'], async ctx => {
  const o = await ownOrder(ctx);
  if (o.status !== 'MENUNGGU_PEMBAYARAN') bad('Pesanan ini tidak menunggu pembayaran', 409);
  await markPaid(o.id);
  return { order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', o.id), ctx.user) };
});

R('POST', '/api/orders/:id/cancel', ['customer'], async ctx => {
  const o = await ownOrder(ctx);
  if (TERMINAL.includes(o.status)) bad('Pesanan sudah selesai/dibatalkan', 409);
  if (o.status !== 'MENUNGGU_PEMBAYARAN' && (o.food_state >= 2 || o.delivery_stage > 0)) {
    bad('Pesanan sudah diproses kantin/kurir sehingga tidak bisa dibatalkan. Hubungi bantuan jika ada masalah.', 409);
  }
  const o2 = await cancelOrder(o.id, String(ctx.body.reason || 'Dibatalkan oleh pembeli').slice(0, 120));
  return { order: await orderView(o2, ctx.user) };
});

R('POST', '/api/orders/:id/retry-courier', ['customer'], async ctx => {
  const o = await ownOrder(ctx);
  if (o.courier_id || TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Tidak perlu mencari kurir lagi', 409);
  await q.run("DELETE FROM deliveries WHERE order_id=? AND status IN('rejected','expired')", o.id);
  await q.run("UPDATE orders SET courier_search='' WHERE id=?", o.id);
  await dispatch(o.id);
  return { order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', o.id), ctx.user) };
});

R('POST', '/api/orders/:id/rate', ['customer'], async ctx => {
  const o = await ownOrder(ctx);
  const b = ctx.body;
  if (o.status !== 'SELESAI') bad('Rating hanya bisa diberikan setelah pesanan selesai', 409);
  if (await q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id)) bad('Pesanan ini sudah dinilai', 409);
  const ms = int(b.merchant_stars, 1, 5, 'Rating kantin');
  const cs = int(b.courier_stars, 1, 5, 'Rating kurir');
  await tx(async () => {
    await q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'merchant',?,?,?)", o.id, o.merchant_id, ms, now());
    await q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'courier',?,?,?)", o.id, o.courier_id, cs, now());
    if (b.review) await q.run('INSERT INTO reviews(order_id,customer_id,text,created_at) VALUES(?,?,?,?)', o.id, ctx.user.id, String(b.review).slice(0, 300), now());
    await q.run('UPDATE merchants SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE id=?', ms, o.merchant_id);
    await q.run('UPDATE courier_profiles SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE user_id=?', cs, o.courier_id);
  });
  return { ok: true };
});

R('POST', '/api/orders/:id/reorder', ['customer'], async ctx => {
  const o = await ownOrder(ctx);
  const cart = await q.get('SELECT id FROM carts WHERE user_id=?', ctx.user.id);
  await q.run('DELETE FROM cart_items WHERE cart_id=?', cart.id);
  let added = 0;
  let skipped = 0;
  for (const i of await q.all('SELECT * FROM order_items WHERE order_id=?', o.id)) {
    const p = await q.get('SELECT * FROM products WHERE id=? AND active=1 AND deleted=0 AND stock>=?', i.product_id, i.qty);
    try {
      if (!p) throw 0;
      const pr = await priceItem(p, json(i.options_json));
      await q.run('INSERT INTO cart_items(cart_id,product_id,options,note,qty) VALUES(?,?,?,?,?)', cart.id, p.id, JSON.stringify(pr.sel), i.note, i.qty);
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
});

/* KURIR */
const COURIER = ['courier'];
R('POST', '/api/courier/online', COURIER, async ctx => {
  const on = ctx.body.online ? 1 : 0;
  await q.run('UPDATE courier_profiles SET online=? WHERE user_id=?', on, ctx.user.id);
  if (!on) await q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE courier_id=? AND status='offered'", now(), ctx.user.id);
  if (on) await tick();
  return { online: !!on };
});

async function offerFor(uid) {
  const d = await q.get("SELECT * FROM deliveries WHERE courier_id=? AND status='offered' AND expires_at>? ORDER BY id LIMIT 1", uid, now());
  if (!d) return null;
  const o = await q.get('SELECT * FROM orders WHERE id=?', d.order_id);
  const m = await q.get('SELECT name,location FROM merchants WHERE id=?', o.merchant_id);
  const itemsRow = await q.get('SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE order_id=?', o.id);
  return {
    id: d.id,
    code: o.code,
    order_id: o.id,
    merchant: m.name,
    pickup: m.location,
    floor: o.floor,
    room: o.room,
    fee: o.delivery_fee,
    items: itemsRow.n,
    remaining: Math.max(0, Math.ceil((d.expires_at - now()) / 1000)),
    total_seconds: Number(await setting('offer_timeout_sec')),
  };
}

R('GET', '/api/courier/offer', COURIER, async ctx => ({ offer: await offerFor(ctx.user.id) }));

R('POST', '/api/courier/offers/:id/accept', COURIER, async ctx => {
  const oid = await tx(async () => {
    const d = (await q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered' AND expires_at>?", Number(ctx.params.id), ctx.user.id, now()))
      || bad('Tawaran sudah kedaluwarsa atau diambil kurir lain', 409);
    const r = await q.run("UPDATE orders SET courier_id=?, courier_search='' WHERE id=? AND courier_id IS NULL AND status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')", ctx.user.id, d.order_id);
    if (r.changes !== 1) bad('Pesanan sudah diambil kurir lain atau dibatalkan', 409);
    await q.run("UPDATE deliveries SET status='accepted', responded_at=? WHERE id=?", now(), d.id);
    const o = await refresh(d.order_id);
    const merch = await q.get('SELECT name FROM merchants WHERE id=?', o.merchant_id);
    await notify(o.customer_id, 'Kurir ditemukan', `${ctx.user.name} akan mengantar pesananmu.`, `#/order/${o.id}`);
    await notify(await ownerOfMerchant(o.merchant_id), 'Kurir ditemukan', `${ctx.user.name} akan mengambil ${o.code}.`, '#/m/orders');
    await notify(ctx.user.id, 'Pesanan diterima', `${o.code}: ambil di ${merch.name}, antar ke Lantai ${o.floor} Ruang ${o.room}.`, '#/c/active');
    return o.id;
  });
  return { order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', oid), ctx.user) };
});

R('POST', '/api/courier/offers/:id/reject', COURIER, async ctx => {
  const d = (await q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered'", Number(ctx.params.id), ctx.user.id))
    || bad('Tawaran tidak ditemukan', 404);
  await q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE id=?", now(), d.id);
  await dispatch(d.order_id);
  return { ok: true };
});

R('GET', '/api/courier/orders', COURIER, async ctx => {
  const hist = ctx.query.history === '1';
  const rows = await q.all(
    `SELECT * FROM orders WHERE courier_id=? AND status ${hist ? "IN('SELESAI','DIBATALKAN')" : "NOT IN('SELESAI','DIBATALKAN')"} ORDER BY id DESC LIMIT 100`,
    ctx.user.id
  );
  return { orders: await Promise.all(rows.map(o => orderView(o, ctx.user))) };
});

async function courierOrder(ctx) {
  return (await q.get('SELECT * FROM orders WHERE id=? AND courier_id=?', Number(ctx.params.id), ctx.user.id)) || bad('Pesanan tidak ditemukan', 404);
}

R('POST', '/api/courier/orders/:id/arrived', COURIER, async ctx => {
  const o = await courierOrder(ctx);
  if (TERMINAL.includes(o.status) || o.delivery_stage !== 0) bad('Status pesanan tidak sesuai', 409);
  await q.run('UPDATE orders SET delivery_stage=1 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(await ownerOfMerchant(o.merchant_id), 'Kurir sudah di kantin', `Kurir menunggu ${o.code}.`, '#/m/orders');
  await notify(o.customer_id, 'Kurir mengambil pesanan', `Kurir sudah tiba di kantin untuk ${o.code}.`, `#/order/${o.id}`);
  return { ok: true };
});

R('POST', '/api/courier/orders/:id/pickup', COURIER, async ctx => {
  const o = await courierOrder(ctx);
  if (TERMINAL.includes(o.status) || o.delivery_stage > 1) bad('Status pesanan tidak sesuai', 409);
  if (o.food_state < 3) bad('Makanan belum ditandai siap oleh kantin', 409);
  await q.run('UPDATE orders SET delivery_stage=2 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Pesanan sedang diantar', `${o.code} dalam pengantaran ke Lantai ${o.floor} Ruang ${o.room}.`, `#/order/${o.id}`);
  await notify(await ownerOfMerchant(o.merchant_id), 'Kurir sudah mengambil makanan', o.code, '#/m/orders');
  return { ok: true };
});

R('POST', '/api/courier/orders/:id/complete', COURIER, async ctx => {
  const o = await courierOrder(ctx);
  if (o.status !== 'DALAM_PENGANTARAN') bad('Pesanan belum dalam pengantaran', 409);
  const r = await q.run("UPDATE orders SET status='SELESAI', completed_at=? WHERE id=? AND status='DALAM_PENGANTARAN'", now(), o.id);
  if (r.changes !== 1) bad('Pesanan sudah selesai', 409);
  await settle(o.id);
  await notify(o.customer_id, 'Pesanan selesai', `${o.code} sudah sampai. Beri rating untuk kantin dan kurir ya.`, `#/order/${o.id}`);
  await notify(ctx.user.id, 'Pendapatan masuk', `+${rp(o.delivery_fee)} dari ${o.code}`, '#/c/earnings');
  return { ok: true };
});

R('GET', '/api/courier/dashboard', COURIER, async ctx => {
  const cp = await q.get('SELECT * FROM courier_profiles WHERE user_id=?', ctx.user.id);
  const w = await walletInfo(ctx.user.id);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const done = (await q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI' AND completed_at>=?", ctx.user.id, start.getTime())).n;
  const total = (await q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI'", ctx.user.id)).n;
  const active = await q.all("SELECT delivery_fee FROM orders WHERE courier_id=? AND status NOT IN('SELESAI','DIBATALKAN')", ctx.user.id);
  return {
    online: !!cp.online,
    rating_avg: cp.rating_avg,
    rating_count: cp.rating_count,
    today_done: done,
    total_done: total,
    active: active.length,
    earned_today: w.today,
    estimate_today: w.today + active.reduce((s, a) => s + a.delivery_fee, 0),
    balance: w.balance,
  };
});

R('GET', '/api/wallet', ['courier', 'merchant', 'admin', 'customer'], ctx => walletInfo(ctx.user.id));

/* MERCHANT */
const MERCH = ['merchant'];
R('GET', '/api/m/store', MERCH, async ctx => ({
  merchant: { ...(await merchantOf(ctx.user)) },
  categories: await q.all('SELECT * FROM categories ORDER BY id'),
}));

R('PUT', '/api/m/store', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const b = ctx.body;
  await q.run(
    'UPDATE merchants SET name=?, description=?, location=?, open=?, eta_min=? WHERE id=?',
    str(b.name, 3, 50, 'Nama kantin'), str(b.description, 0, 300, 'Deskripsi'), str(b.location || '', 0, 100, 'Lokasi'),
    b.open ? 1 : 0, int(b.eta_min, 3, 60, 'Estimasi'), m.id
  );
  return { merchant: await merchantOf(ctx.user) };
});

R('GET', '/api/m/products', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const raw = await q.all('SELECT * FROM products WHERE merchant_id=? AND deleted=0 ORDER BY id', m.id);
  return {
    products: await Promise.all(raw.map(p => productView(p))),
    categories: await q.all('SELECT * FROM categories ORDER BY id'),
  };
});

async function readProduct(b) {
  const out = {
    name: str(b.name, 2, 60, 'Nama menu'),
    description: str(b.description || '', 0, 300, 'Deskripsi'),
    base_price: int(b.base_price, 500, 1000000, 'Harga'),
    stock: int(b.stock, 0, 9999, 'Stok'),
    active: b.active ? 1 : 0,
    popular: b.popular ? 1 : 0,
    image: b.image || 'default',
  };
  if (out.image.startsWith('data:')) {
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(out.image)) bad('Format foto harus PNG/JPG/WEBP/GIF');
    if (out.image.length > 2_500_000) bad('Ukuran foto maksimal ±1,8 MB');
  } else if (!/^[a-z]{3,10}$/.test(out.image)) bad('Foto tidak valid');
  const cat = str(b.category || 'Lainnya', 2, 30, 'Kategori');
  await q.run('INSERT OR IGNORE INTO categories(name) VALUES(?)', cat);
  out.category_id = (await q.get('SELECT id FROM categories WHERE name=?', cat)).id;
  const vs = Array.isArray(b.variants) ? b.variants : [];
  if (vs.length > 60) bad('Terlalu banyak variasi');
  out.variants = vs.map((v, i) => ({
    group_name: str(v.group_name, 1, 40, 'Nama grup variasi'),
    label: str(v.label, 1, 40, 'Nama pilihan'),
    price_delta: int(v.price_delta ?? 0, -100000, 100000, 'Harga tambahan'),
    required: v.required ? 1 : 0,
    is_default: v.is_default ? 1 : 0,
    show_if: v.show_if ? str(v.show_if, 3, 90, 'Syarat tampil') : null,
    sort: i,
  }));
  const gs = [...new Set(out.variants.map(v => v.group_name))];
  out.variants.forEach(v => { v.sort = gs.indexOf(v.group_name); });
  return out;
}

async function saveProduct(mid, id, p) {
  return tx(async () => {
    if (!id) {
      const r = await q.run(
        'INSERT INTO products(merchant_id,category_id,name,description,base_price,image,stock,active,popular) VALUES(?,?,?,?,?,?,?,?,?)',
        mid, p.category_id, p.name, p.description, p.base_price, p.image, p.stock, p.active, p.popular
      );
      id = Number(r.lastInsertRowid);
    } else {
      await q.run(
        'UPDATE products SET category_id=?,name=?,description=?,base_price=?,image=?,stock=?,active=?,popular=? WHERE id=?',
        p.category_id, p.name, p.description, p.base_price, p.image, p.stock, p.active, p.popular, id
      );
    }
    await q.run('DELETE FROM product_variants WHERE product_id=?', id);
    for (const v of p.variants) {
      await q.run(
        'INSERT INTO product_variants(product_id,group_name,label,price_delta,required,is_default,show_if,sort) VALUES(?,?,?,?,?,?,?,?)',
        id, v.group_name, v.label, v.price_delta, v.required, v.is_default, v.show_if, v.sort
      );
    }
    return id;
  });
}

const ownProduct = async (ctx, m) =>
  (await q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', Number(ctx.params.id), m.id)) || bad('Menu tidak ditemukan', 404);

R('POST', '/api/m/products', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const id = await saveProduct(m.id, null, await readProduct(ctx.body));
  return { product: await productView(await q.get('SELECT * FROM products WHERE id=?', id)) };
});

R('PUT', '/api/m/products/:id', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const p = await ownProduct(ctx, m);
  await saveProduct(m.id, p.id, await readProduct(ctx.body));
  return { product: await productView(await q.get('SELECT * FROM products WHERE id=?', p.id)) };
});

R('PATCH', '/api/m/products/:id/stock', MERCH, async ctx => {
  const p = await ownProduct(ctx, await merchantOf(ctx.user));
  await q.run('UPDATE products SET stock=? WHERE id=?', int(ctx.body.stock, 0, 9999, 'Stok'), p.id);
  return { ok: true };
});

R('PATCH', '/api/m/products/:id/active', MERCH, async ctx => {
  const p = await ownProduct(ctx, await merchantOf(ctx.user));
  await q.run('UPDATE products SET active=? WHERE id=?', ctx.body.active ? 1 : 0, p.id);
  return { ok: true };
});

R('DELETE', '/api/m/products/:id', MERCH, async ctx => {
  const p = await ownProduct(ctx, await merchantOf(ctx.user));
  await tx(async () => {
    await q.run('UPDATE products SET deleted=1, active=0 WHERE id=?', p.id);
    await q.run('DELETE FROM cart_items WHERE product_id=?', p.id);
    await q.run('DELETE FROM favorites WHERE product_id=?', p.id);
    await q.run('UPDATE vouchers SET active=0 WHERE product_id=?', p.id);
  });
  return { ok: true };
});

R('GET', '/api/m/orders', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const rows = await q.all(
    "SELECT * FROM orders WHERE merchant_id=? AND status!='MENUNGGU_PEMBAYARAN' AND NOT (status='DIBATALKAN' AND paid_at IS NULL AND type='online') ORDER BY id DESC LIMIT 150",
    m.id
  );
  return { orders: await Promise.all(rows.map(o => orderView(o, ctx.user))) };
});

async function merchOrder(ctx) {
  const m = await merchantOf(ctx.user);
  const o = (await q.get("SELECT * FROM orders WHERE id=? AND merchant_id=? AND type='online'", Number(ctx.params.id), m.id))
    || bad('Pesanan tidak ditemukan', 404);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Pesanan tidak bisa diubah', 409);
  return o;
}

R('POST', '/api/m/orders/:id/accept', MERCH, async ctx => {
  const o = await merchOrder(ctx);
  if (o.food_state !== 0) bad('Pesanan sudah diterima', 409);
  await q.run('UPDATE orders SET food_state=1 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Pesanan diterima kantin', `${o.code} akan segera disiapkan.`, `#/order/${o.id}`);
  return { ok: true };
});

R('POST', '/api/m/orders/:id/reject', MERCH, async ctx => {
  const o = await merchOrder(ctx);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan, tidak bisa ditolak', 409);
  await cancelOrder(o.id, 'Ditolak kantin: ' + str(ctx.body.reason, 3, 120, 'Alasan penolakan'));
  return { ok: true };
});

R('POST', '/api/m/orders/:id/prepare', MERCH, async ctx => {
  const o = await merchOrder(ctx);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan', 409);
  await q.run('UPDATE orders SET food_state=2 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Makanan sedang disiapkan', `${o.code} sedang dimasak.`, `#/order/${o.id}`);
  return { ok: true };
});

R('POST', '/api/m/orders/:id/ready', MERCH, async ctx => {
  const o = await merchOrder(ctx);
  if (o.food_state !== 2) bad('Tandai "sedang disiapkan" terlebih dahulu', 409);
  await q.run('UPDATE orders SET food_state=3 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Makanan siap diambil', `${o.code} siap diambil kurir.`, `#/order/${o.id}`);
  await notify(o.courier_id, 'Makanan siap diambil', `${o.code} sudah siap di kantin.`, '#/c/active');
  return { ok: true };
});

R('POST', '/api/m/offline', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) bad('Pilih minimal satu menu');
  const id = await tx(async () => {
    let subtotal = 0;
    const lines = [];
    for (const it of items) {
      const p = (await q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', Number(it.product_id), m.id))
        || bad('Menu tidak ditemukan', 404);
      const qty = int(it.qty, 1, 50, 'Jumlah');
      const opts = it.options && Object.keys(it.options).length ? it.options : await defaultOptions(p);
      const pr = await priceItem(p, opts);
      await reserveStock(p.id, qty);
      subtotal += pr.unit * qty;
      lines.push({ p, qty, pr });
    }
    const t = now();
    const oRes = await q.run(
      "INSERT INTO orders(code,merchant_id,type,status,food_state,subtotal,delivery_fee,discount,total,recipient,created_at,paid_at,completed_at,settled) VALUES(?,?,'offline','SELESAI',3,?,0,0,?,?,?,?,?,1)",
      (await newCode()).replace('CE-', 'OFF-'), m.id, subtotal, subtotal, String(ctx.body.note || 'Pembeli offline').slice(0, 60), t, t, t
    );
    const oid = Number(oRes.lastInsertRowid);
    for (const l of lines) {
      await q.run(
        'INSERT INTO order_items(order_id,product_id,name,options_text,options_json,qty,unit_price) VALUES(?,?,?,?,?,?,?)',
        oid, l.p.id, l.p.name, l.pr.text, JSON.stringify(l.pr.sel), l.qty, l.pr.unit
      );
      await q.run('UPDATE products SET sold=sold+? WHERE id=?', l.qty, l.p.id);
    }
    return oid;
  });
  return { order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', id), ctx.user) };
});

R('GET', '/api/m/report', MERCH, async ctx => report(ctx.query.mode === 'monthly' ? 'monthly' : 'daily', (await merchantOf(ctx.user)).id));

R('GET', '/api/m/dashboard', MERCH, async ctx => {
  const m = await merchantOf(ctx.user);
  const w = await walletInfo(ctx.user.id);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayRows = await q.get("SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) s FROM orders WHERE merchant_id=? AND status='SELESAI' AND COALESCE(completed_at,created_at)>=?", m.id, start.getTime());
  return {
    merchant: { ...m, open: !!m.open },
    wallet: { balance: w.balance, today: w.today, month: w.month },
    today_orders: todayRows.n,
    today_sales: todayRows.s,
    pending: (await q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state=0 AND status NOT IN('MENUNGGU_PEMBAYARAN','SELESAI','DIBATALKAN')", m.id)).n,
    processing: (await q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state IN(1,2,3) AND status NOT IN('SELESAI','DIBATALKAN')", m.id)).n,
    low_stock: await q.all('SELECT name,stock FROM products WHERE merchant_id=? AND deleted=0 AND active=1 AND stock<=5 ORDER BY stock', m.id),
    chart: await report('daily', m.id),
  };
});

/* ADMIN */
const ADMIN = ['admin'];
R('GET', '/api/admin/overview', ADMIN, async () => {
  const c = async (sql, ...a) => (await q.get(sql, ...a)).n;
  const admin = await q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  return {
    customers: await c("SELECT COUNT(*) n FROM users WHERE role='customer' AND deleted=0"),
    couriers: await c("SELECT COUNT(*) n FROM users WHERE role='courier' AND deleted=0"),
    couriers_online: await c("SELECT COUNT(*) n FROM courier_profiles cp JOIN users u ON u.id=cp.user_id WHERE cp.online=1 AND u.active=1 AND u.deleted=0"),
    merchants: await c("SELECT COUNT(*) n FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.deleted=0"),
    orders: await c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('MENUNGGU_PEMBAYARAN') AND NOT(status='DIBATALKAN' AND paid_at IS NULL)"),
    orders_active: await c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')"),
    transactions: await c("SELECT COUNT(*) n FROM payments WHERE status IN('PAID','REFUNDED')"),
    gross: (await q.get("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='SELESAI'")).n,
    platform_balance: admin ? (await walletInfo(admin.id)).balance : 0,
    complaints_open: await c("SELECT COUNT(*) n FROM complaints WHERE status='baru'"),
    chart: await report('daily', null),
  };
});

R('GET', '/api/admin/users', ADMIN, async ctx => {
  const { role, q: qs, status } = ctx.query;
  let sql = `SELECT u.id,u.username,u.name,u.phone,u.role,u.active,u.created_at,
    (SELECT online FROM courier_profiles WHERE user_id=u.id) online, (SELECT rating_avg FROM courier_profiles WHERE user_id=u.id) rating,
    (SELECT name FROM merchants WHERE owner_id=u.id) store,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id OR o.courier_id=u.id OR o.merchant_id=(SELECT id FROM merchants WHERE owner_id=u.id)) orders
    FROM users u WHERE u.deleted=0`;
  const a = [];
  if (role) { sql += ' AND u.role=?'; a.push(role); }
  if (status === 'active') sql += ' AND u.active=1';
  if (status === 'inactive') sql += ' AND u.active=0';
  if (qs) { sql += ' AND (u.username LIKE ? OR u.name LIKE ?)'; a.push(`%${qs}%`, `%${qs}%`); }
  return { users: await q.all(sql + ' ORDER BY u.id', ...a) };
});

async function targetUser(ctx) {
  const u = (await q.get('SELECT * FROM users WHERE id=? AND deleted=0', Number(ctx.params.id))) || bad('Pengguna tidak ditemukan', 404);
  if (u.role === 'admin') bad('Akun admin tidak bisa diubah dari sini', 403);
  return u;
}

const hasActiveOrders = async u =>
  (await q.get("SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN') AND (customer_id=? OR courier_id=? OR merchant_id=(SELECT id FROM merchants WHERE owner_id=?))", u.id, u.id, u.id)).n > 0;

R('POST', '/api/admin/users/:id/active', ADMIN, async ctx => {
  const u = await targetUser(ctx);
  const on = ctx.body.active ? 1 : 0;
  if (!on && (await hasActiveOrders(u))) bad('Pengguna masih memiliki pesanan berjalan', 409);
  await q.run('UPDATE users SET active=? WHERE id=?', on, u.id);
  if (!on) {
    await q.run('DELETE FROM sessions WHERE user_id=?', u.id);
    await q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id);
  }
  await notify(u.id, on ? 'Akun diaktifkan kembali' : 'Akun dinonaktifkan', on ? 'Kamu bisa menggunakan Campus Eats lagi.' : 'Hubungi admin untuk informasi lebih lanjut.');
  return { ok: true };
});

R('DELETE', '/api/admin/users/:id', ADMIN, async ctx => {
  const u = await targetUser(ctx);
  if (u.role === 'customer') bad('Akun pembeli cukup dinonaktifkan, tidak dihapus', 403);
  if (await hasActiveOrders(u)) bad('Pengguna masih memiliki pesanan berjalan', 409);
  await tx(async () => {
    await q.run("UPDATE users SET deleted=1, active=0, username=username||'#del'||id WHERE id=?", u.id);
    await q.run('DELETE FROM sessions WHERE user_id=?', u.id);
    await q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id);
    await q.run('UPDATE merchants SET open=0 WHERE owner_id=?', u.id);
  });
  return { ok: true };
});

R('GET', '/api/admin/orders', ADMIN, async ctx => {
  let sql = 'SELECT o.*, m.name merchant_name, (SELECT name FROM users WHERE id=o.customer_id) customer_name, (SELECT name FROM users WHERE id=o.courier_id) courier_name FROM orders o JOIN merchants m ON m.id=o.merchant_id WHERE 1=1';
  const a = [];
  if (ctx.query.status) { sql += ' AND o.status=?'; a.push(ctx.query.status); }
  if (ctx.query.q) { sql += ' AND o.code LIKE ?'; a.push(`%${ctx.query.q}%`); }
  return { orders: await q.all(sql + ' ORDER BY o.id DESC LIMIT 200', ...a) };
});

R('GET', '/api/admin/transactions', ADMIN, async () => ({
  payments: await q.all('SELECT p.*, o.code FROM payments p JOIN orders o ON o.id=p.order_id ORDER BY p.id DESC LIMIT 200'),
  wallet: await q.all("SELECT wt.*, u.name user_name, u.role FROM wallet_transactions wt JOIN wallets w ON w.id=wt.wallet_id JOIN users u ON u.id=w.user_id WHERE wt.type!='refund' ORDER BY wt.id DESC LIMIT 200"),
}));

R('GET', '/api/admin/report', ADMIN, async ctx => ({
  ...(await report(ctx.query.mode === 'monthly' ? 'monthly' : 'daily', null)),
  complaints: await q.all('SELECT c.*, u.name user_name, u.role, o.code FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN orders o ON o.id=c.order_id ORDER BY c.id DESC LIMIT 100'),
}));

R('POST', '/api/admin/complaints/:id/resolve', ADMIN, async ctx => {
  await q.run("UPDATE complaints SET status='selesai' WHERE id=?", Number(ctx.params.id));
  return { ok: true };
});

R('GET', '/api/admin/settings', ADMIN, async () => {
  const fees = Object.fromEntries(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(async f => [f, await feeFor(f)])));
  return {
    fees,
    commission_pct: Number(await setting('commission_pct')),
    offer_timeout_sec: Number(await setting('offer_timeout_sec')),
    payment_timeout_sec: Number(await setting('payment_timeout_sec')),
    vouchers: await q.all('SELECT * FROM vouchers ORDER BY rowid'),
  };
});

R('PUT', '/api/admin/settings', ADMIN, async ctx => {
  const b = ctx.body;
  await tx(async () => {
    for (let f = 1; f <= 9; f++) {
      await q.run('UPDATE settings SET value=? WHERE key=?', String(int(b.fees?.[f], 0, 50000, `Ongkir lantai ${f}`)), 'fee_' + f);
    }
    await q.run("UPDATE settings SET value=? WHERE key='commission_pct'", String(int(b.commission_pct, 0, 50, 'Komisi')));
    await q.run("UPDATE settings SET value=? WHERE key='offer_timeout_sec'", String(int(b.offer_timeout_sec, 10, 120, 'Batas waktu kurir')));
    await q.run("UPDATE settings SET value=? WHERE key='payment_timeout_sec'", String(int(b.payment_timeout_sec, 60, 1800, 'Batas waktu bayar')));
  });
  return { ok: true };
});

R('POST', '/api/admin/vouchers', ADMIN, async ctx => {
  const b = ctx.body;
  const code = str(b.code, 3, 20, 'Kode').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) bad('Kode hanya huruf & angka');
  if (await q.get('SELECT 1 x FROM vouchers WHERE code=?', code)) bad('Kode sudah ada', 409);
  const type = ['fixed', 'free_shipping', 'percent'].includes(b.type) ? b.type : bad('Tipe voucher tidak valid');
  await q.run(
    'INSERT INTO vouchers(code,description,type,value,min_subtotal,product_id) VALUES(?,?,?,?,?,?)',
    code, str(b.description, 3, 120, 'Deskripsi'), type,
    int(b.value ?? 0, 0, type === 'percent' ? 100 : 100000, 'Nilai'),
    int(b.min_subtotal ?? 0, 0, 1000000, 'Minimal belanja'),
    b.product_id ? Number(b.product_id) : null
  );
  return { ok: true };
});

R('POST', '/api/admin/vouchers/:code/toggle', ADMIN, async ctx => {
  await q.run('UPDATE vouchers SET active=1-active WHERE code=?', ctx.params.code);
  return { ok: true };
});

/* ---------- dispatcher ---------- */
async function handle(req, res, url, body) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
  const token = cookies.ce_sid;
  const sess = token ? await q.get('SELECT user_id FROM sessions WHERE token=? AND expires_at>?', token, now()) : null;
  const user = sess ? await q.get('SELECT * FROM users WHERE id=? AND deleted=0', sess.user_id) : null;
  const ctx = {
    user: user && user.active ? user : null,
    token,
    body,
    query: Object.fromEntries(url.searchParams),
    params: {},
    ip: req.socket.remoteAddress,
  };
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
