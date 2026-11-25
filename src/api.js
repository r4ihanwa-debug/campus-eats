const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx, now, hashPw, verifyPw, createUser } = require('./db');
const payment = require('./payment');
const { AppError, bad } = require('./errors');
const { signToken, setAuthCookie, clearAuthCookie, optionalAuth, requireAuth, requireRole } = require('./auth');
const V = require('./validators');

const router = express.Router();
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
const setting = async k => (await q.get('SELECT value FROM settings WHERE key=?', k))?.value;
const feeFor = async f => Number(await setting('fee_' + f));
const TERMINAL = ['SELESAI', 'DIBATALKAN'];
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
      if (g.required) bad(`Pilih ${g.name} terlebih dahulu`, 400, 'VALIDATION_ERROR');
      continue;
    }
    const v = g.items.find(i => i.label === pick) || bad(`Pilihan ${g.name} tidak valid`, 400, 'VALIDATION_ERROR');
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
    const p = await q.get('SELECT name,stock,active,deleted FROM products WHERE id=?', productId);
    if (!p || !p.active || p.deleted) {
      bad(`Menu ${p?.name || ''} sedang tidak tersedia`, 409, 'MENU_UNAVAILABLE');
    }
    bad(`Stok ${p.name} tidak mencukupi (tersisa ${p.stock})`, 409, 'OUT_OF_STOCK');
  }
}
async function releaseStock(orderId) {
  const items = await q.all('SELECT product_id,qty FROM order_items WHERE order_id=?', orderId);
  for (const i of items) {
    await q.run('UPDATE products SET stock=stock+? WHERE id=?', i.qty, i.product_id);
  }
}

/* ---------- status pesanan & pembayaran ---------- */
async function refresh(id) {
  const o = await q.get('SELECT * FROM orders WHERE id=?', id);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') {
    const stage = payment.deriveOrderStage(o.status);
    if (o.stage !== stage) await q.run('UPDATE orders SET stage=? WHERE id=?', stage, id);
    return { ...o, stage };
  }
  let s;
  if (o.delivery_stage === 2) s = 'DALAM_PENGANTARAN';
  else if (o.delivery_stage === 1) s = 'KURIR_MENGAMBIL';
  else if (o.food_state === 3) s = 'SIAP_DIAMBIL';
  else if (o.food_state === 2) s = 'SEDANG_DISIAPKAN';
  else if (o.courier_id) s = o.food_state === 1 ? 'MENUNGGU_DISIAPKAN' : 'KURIR_DITEMUKAN';
  else s = 'MENCARI_KURIR';
  const stage = payment.deriveOrderStage(s);
  if (s !== o.status || stage !== o.stage) {
    await q.run('UPDATE orders SET status=?, stage=? WHERE id=?', s, stage, id);
  }
  return { ...o, status: s, stage };
}

async function cancelOrder(id, reason, paymentTargetStatus = null) {
  return tx(async () => {
    const o = await q.get('SELECT * FROM orders WHERE id=?', id);
    if (!o || TERMINAL.includes(o.status)) bad('Pesanan tidak bisa dibatalkan', 409);
    const currentStage = payment.deriveOrderStage(o.status);
    payment.assertOrderStageTransition(currentStage, payment.ORDER_STAGE.DIBATALKAN);

    const paid = o.status !== 'MENUNGGU_PEMBAYARAN';
    const nextPayStatus = paymentTargetStatus || (paid ? payment.PAYMENT_STATUS.REFUNDED : payment.PAYMENT_STATUS.CANCELLED);

    await q.run("UPDATE orders SET status='DIBATALKAN', stage='dibatalkan', cancel_reason=?, courier_search='' WHERE id=?", reason, id);
    await q.run("UPDATE deliveries SET status='cancelled', responded_at=? WHERE order_id=? AND status IN('offered','accepted')", now(), id);
    await releaseStock(id);

    const pay = await q.get('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1', id);
    if (pay && payment.canTransitionPayment(pay.status, nextPayStatus)) {
      await q.run('UPDATE payments SET status=?, updated_at=? WHERE id=?', nextPayStatus, now(), pay.id);
    }

    if (paid && o.customer_id) await credit(o.customer_id, o.total, 'refund', `Refund pesanan ${o.code}`, id);
    await notify(o.customer_id, 'Pesanan dibatalkan', `${o.code}: ${reason}${paid ? `. Saldo refund ${rp(o.total)} sudah masuk.` : ''}`, `#/order/${id}`);
    if (paid) await notify(await ownerOfMerchant(o.merchant_id), 'Pesanan dibatalkan', `${o.code}: ${reason}`, '#/m/orders');
    if (o.courier_id) await notify(o.courier_id, 'Pesanan dibatalkan', `${o.code} dibatalkan: ${reason}`, '#/c/active');
    return q.get('SELECT * FROM orders WHERE id=?', id);
  });
}

async function confirmOrderPayment(orderId) {
  const res = await tx(async () => {
    const o = await q.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o) bad('Pesanan tidak ditemukan', 404);
    const pay = await q.get('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1', orderId);
    if (!pay) bad('Data pembayaran tidak ditemukan', 404);

    const payStatus = payment.normalizePaymentStatus(pay.status);
    if (payStatus === payment.PAYMENT_STATUS.PAID && o.status !== 'MENUNGGU_PEMBAYARAN') {
      if (o.status === 'DIBATALKAN') bad('Pesanan sudah dibatalkan', 409);
      return { idempotent: true, expired: false, order: o };
    }

    if (o.status !== 'MENUNGGU_PEMBAYARAN') {
      bad('Pesanan ini tidak menunggu pembayaran', 409);
    }

    const payTimeoutSec = Number(await setting('payment_timeout_sec'));
    const expiresAt = pay.expires_at || (o.created_at + payTimeoutSec * 1000);
    if (now() > expiresAt) {
      await cancelOrder(orderId, 'Waktu pembayaran habis', payment.PAYMENT_STATUS.EXPIRED);
      return { idempotent: false, expired: true, order: null };
    }

    payment.assertPaymentTransition(pay.status, payment.PAYMENT_STATUS.PAID);
    payment.assertOrderStageTransition(payment.deriveOrderStage(o.status), payment.ORDER_STAGE.DIPROSES);

    const t = now();
    const r = await q.run(
      "UPDATE orders SET status='PEMBAYARAN_BERHASIL', stage='diproses', paid_at=? WHERE id=? AND status='MENUNGGU_PEMBAYARAN'",
      t, orderId
    );
    if (r.changes !== 1) bad('Pesanan tidak dalam status menunggu pembayaran', 409);

    await q.run(
      "UPDATE payments SET status='paid', paid_at=?, updated_at=? WHERE id=? AND LOWER(status)='pending'",
      t, t, pay.id
    );
    const updated = await refresh(orderId);
    await notify(updated.customer_id, 'Pembayaran berhasil', `Pesanan ${updated.code} sedang dicarikan kurir.`, `#/order/${updated.id}`);
    await notify(await ownerOfMerchant(updated.merchant_id), 'Pesanan online baru', `${updated.code} - ${rp(updated.subtotal)}. Segera terima pesanan.`, '#/m/orders');
    await notifyAdmins('Transaksi baru', `${updated.code} senilai ${rp(updated.total)}`, '#/a/transactions');
    return { idempotent: false, expired: false, order: updated };
  });

  if (res.expired) bad('Waktu pembayaran sudah habis', 409, 'PAYMENT_EXPIRED');
  if (!res.idempotent) await dispatch(res.order.id);
  return res;
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
      try { await cancelOrder(o.id, 'Waktu pembayaran habis', payment.PAYMENT_STATUS.EXPIRED); } catch {}
    }
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
  const pay = await q.get('SELECT method,provider,ref,status,expires_at FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id);
  const customer = o.customer_id ? await q.get('SELECT name,phone FROM users WHERE id=?', o.customer_id) : null;
  const rated = !!(await q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id));
  const payTimeout = Number(await setting('payment_timeout_sec'));
  const view = {
    ...o,
    stage: o.stage || payment.deriveOrderStage(o.status),
    merchant: m,
    courier,
    payment: pay ? { ...pay, status: payment.normalizePaymentStatus(pay.status) } : null,
    rated,
    items,
    customer: viewer?.role === 'customer' ? undefined : customer,
    eta: m ? m.eta_min + Math.ceil((o.floor || 1) / 2) + 2 : null,
    payment_expires_at: o.status === 'MENUNGGU_PEMBAYARAN' ? (pay?.expires_at || (o.created_at + payTimeout * 1000)) : null,
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

/* ---------- AUTH ---------- */
const fails = new Map();
const loginIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Terlalu banyak permintaan login. Coba lagi dalam beberapa menit.',
      },
    });
  },
});

router.post('/auth/login', loginIpLimiter, V.validateBody(V.loginSchema), asyncHandler(async (req, res) => {
  const username = req.body.username;
  const key = (req.ip || 'unknown') + '|' + username.toLowerCase();
  const f = fails.get(key);
  if (f && f.n >= 5 && now() - f.t < 600000) {
    bad('Terlalu banyak percobaan login. Coba lagi dalam 10 menit.', 429, 'RATE_LIMITED');
  }
  const u = await q.get('SELECT * FROM users WHERE username=? AND deleted=0', username);
  if (!u || !(await verifyPw(req.body.password, u.password_hash))) {
    if (fails.size > 5000) fails.clear();
    fails.set(key, { n: (f && now() - f.t < 600000 ? f.n : 0) + 1, t: now() });
    bad('Username atau password salah', 401, 'INVALID_CREDENTIALS');
  }
  if (!u.active) bad('Akun dinonaktifkan. Hubungi admin Campus Eats.', 403, 'ACCOUNT_DISABLED');
  fails.delete(key);

  const token = signToken(u);
  setAuthCookie(res, token);
  res.json({ user: await publicUser(u), token });
}));

router.post('/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.post('/auth/register', loginIpLimiter, V.validateBody(V.registerSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  if (await q.get('SELECT 1 x FROM users WHERE username=?', b.username)) {
    bad('Username sudah dipakai', 409, 'USERNAME_TAKEN', { username: 'Username sudah dipakai' });
  }
  const id = await tx(async () => {
    const newId = await createUser({
      username: b.username,
      password: b.password,
      role: b.role,
      name: b.name,
      phone: b.phone || null,
    });
    if (b.role === 'merchant') {
      const storeName = (b.store_name && b.store_name.trim().length >= 3) ? b.store_name.trim() : b.name;
      await q.run(
        'INSERT INTO merchants(owner_id,name,description,open) VALUES(?,?,?,0)',
        newId, storeName.slice(0, 50), 'Kantin baru di Campus Eats.'
      );
    }
    await notifyAdmins(
      b.role === 'courier' ? 'Kurir baru' : b.role === 'merchant' ? 'Kantin baru' : 'Pengguna baru',
      `${b.name} (@${b.username}) mendaftar`,
      '#/a/users'
    );
    return newId;
  });

  const u = await q.get('SELECT * FROM users WHERE id=?', id);
  const token = signToken(u);
  setAuthCookie(res, token);
  res.status(201).json({ user: await publicUser(u), token });
}));

router.get('/me', optionalAuth, asyncHandler(async (req, res) => {
  res.json({ user: req.user ? await publicUser(req.user) : null });
}));

router.put('/profile', requireAuth, V.validateBody(V.profileSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  const u = req.user;
  await q.run('UPDATE users SET name=?, phone=? WHERE id=?', b.name, b.phone ?? null, u.id);
  if (u.role === 'customer') {
    await q.run(
      'UPDATE customer_profiles SET default_floor=?, default_room=? WHERE user_id=?',
      b.default_floor ?? null, b.default_room ?? null, u.id
    );
  }
  res.json({ user: await publicUser(await q.get('SELECT * FROM users WHERE id=?', u.id)) });
}));

router.post('/profile/password', requireAuth, V.validateBody(V.passwordChangeSchema), asyncHandler(async (req, res) => {
  if (!(await verifyPw(req.body.current, req.user.password_hash))) {
    bad('Password lama salah', 400, 'INVALID_PASSWORD', { current: 'Password lama salah' });
  }
  await q.run('UPDATE users SET password_hash=? WHERE id=?', await hashPw(req.body.next), req.user.id);
  res.json({ ok: true });
}));

/* ---------- NOTIFIKASI & PENGADUAN ---------- */
router.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
  res.json({
    items: await q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
    unread: (await q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', req.user.id)).c,
  });
}));

router.post('/notifications/read', requireAuth, asyncHandler(async (req, res) => {
  await q.run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id);
  res.json({ ok: true });
}));

router.post('/complaints', requireAuth, requireRole('customer', 'courier', 'merchant'), V.validateBody(V.complaintSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  let oid = null;
  if (b.order_id) {
    const o = await q.get('SELECT * FROM orders WHERE id=?', b.order_id);
    if (!o || !(await canSee(req.user, o))) bad('Pesanan tidak ditemukan', 404);
    oid = o.id;
  }
  await q.run(
    'INSERT INTO complaints(user_id,order_id,subject,message,created_at) VALUES(?,?,?,?,?)',
    req.user.id, oid, b.subject, b.message, now()
  );
  await notifyAdmins('Pengaduan baru', `${req.user.name}: ${b.subject.slice(0, 60)}`, '#/a/reports');
  res.json({ ok: true });
}));

/* ---------- KATALOG (customer) ---------- */
router.get('/merchants', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const merchants = await q.all('SELECT m.* FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.active=1 AND u.deleted=0');
  res.json({
    merchants: merchants.map(m => ({ ...m, open: !!m.open })),
    categories: await q.all('SELECT * FROM categories ORDER BY id'),
  });
}));

router.get('/menu', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const qs = String(req.query.q || '').toLowerCase();
  const cat = req.query.cat;
  const raw = await q.all(
    `SELECT p.* FROM products p JOIN merchants m ON m.id=p.merchant_id JOIN users u ON u.id=m.owner_id
    WHERE p.deleted=0 AND p.active=1 AND u.active=1 AND u.deleted=0 ORDER BY p.popular DESC, p.sold DESC`
  );
  let rows = await Promise.all(raw.map(p => productView(p, req.user.id)));
  if (cat && cat !== 'Semua') rows = rows.filter(p => p.category === cat);
  if (qs) rows = rows.filter(p => p.name.toLowerCase().includes(qs) || (p.category || '').toLowerCase().includes(qs));
  res.json({ products: rows });
}));

router.get('/products/:id', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const pid = V.parseId(req.params.id, 'ID menu');
  const p = (await q.get(
    `SELECT p.* FROM products p JOIN merchants m ON m.id=p.merchant_id JOIN users u ON u.id=m.owner_id
    WHERE p.id=? AND p.deleted=0 AND p.active=1 AND u.active=1 AND u.deleted=0`,
    pid
  )) || bad('Menu tidak tersedia', 404);
  const m = await q.get('SELECT id,name,open,eta_min FROM merchants WHERE id=?', p.merchant_id);
  res.json({ product: await productView(p, req.user.id), merchant: { ...m, open: !!m.open } });
}));

router.get('/favorites', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const rows = await q.all('SELECT p.* FROM products p JOIN favorites f ON f.product_id=p.id WHERE f.user_id=? AND p.deleted=0 AND p.active=1', req.user.id);
  res.json({ products: await Promise.all(rows.map(p => productView(p, req.user.id))) });
}));

router.post('/favorites/:id', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const pid = V.parseId(req.params.id, 'ID menu');
  if (!(await q.get('SELECT 1 x FROM products WHERE id=? AND deleted=0 AND active=1', pid))) bad('Menu tidak ditemukan', 404);
  const has = await q.get('SELECT 1 x FROM favorites WHERE user_id=? AND product_id=?', req.user.id, pid);
  if (has) await q.run('DELETE FROM favorites WHERE user_id=? AND product_id=?', req.user.id, pid);
  else await q.run('INSERT INTO favorites(user_id,product_id) VALUES(?,?)', req.user.id, pid);
  res.json({ fav: !has });
}));

router.get('/fees', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const entries = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(async f => [f, await feeFor(f)]));
  res.json({
    fees: Object.fromEntries(entries),
    vouchers: await q.all('SELECT v.*, p.name product_name FROM vouchers v LEFT JOIN products p ON p.id=v.product_id WHERE v.active=1'),
  });
}));

/* ---------- KERANJANG ---------- */
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

router.get('/cart', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  res.json(await cartView(req.user.id));
}));

router.post('/cart/items', requireAuth, requireRole('customer'), V.validateBody(V.cartAddSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  const p = (await q.get(
    `SELECT p.* FROM products p JOIN merchants m ON m.id=p.merchant_id JOIN users u ON u.id=m.owner_id
    WHERE p.id=? AND p.deleted=0 AND p.active=1 AND u.active=1 AND u.deleted=0`,
    b.product_id
  )) || bad('Menu tidak tersedia', 404);
  const price = await priceItem(p, b.options);
  const cart = await q.get('SELECT id FROM carts WHERE user_id=?', req.user.id);
  const other = await q.get('SELECT p.merchant_id FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=? LIMIT 1', cart.id);
  if (other && other.merchant_id !== p.merchant_id) bad('Keranjang hanya bisa berisi menu dari satu kantin', 409);
  const note = b.note ? b.note.slice(0, 200) : null;
  const opts = JSON.stringify(price.sel);
  const same = await q.get("SELECT * FROM cart_items WHERE cart_id=? AND product_id=? AND options=? AND COALESCE(note,'')=?", cart.id, p.id, opts, note || '');
  const total = (same?.qty || 0) + b.qty;
  if (total > 20) bad('Maksimal 20 porsi per item');
  if (total > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409, 'OUT_OF_STOCK');
  if (same) await q.run('UPDATE cart_items SET qty=? WHERE id=?', total, same.id);
  else await q.run('INSERT INTO cart_items(cart_id,product_id,options,note,qty) VALUES(?,?,?,?,?)', cart.id, p.id, opts, note, b.qty);
  res.json(await cartView(req.user.id));
}));

async function ownCartItem(req) {
  const itemId = V.parseId(req.params.id, 'ID item');
  return (await q.get('SELECT ci.* FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=? AND c.user_id=?', itemId, req.user.id))
    || bad('Item tidak ditemukan', 404);
}

router.patch('/cart/items/:id', requireAuth, requireRole('customer'), V.validateBody(V.cartPatchSchema), asyncHandler(async (req, res) => {
  const ci = await ownCartItem(req);
  const b = req.body;
  const p = await q.get('SELECT * FROM products WHERE id=? AND deleted=0 AND active=1', ci.product_id);
  if (!p) bad('Menu tidak tersedia', 409, 'MENU_UNAVAILABLE');
  const qty = b.qty !== undefined ? b.qty : ci.qty;
  if (qty > p.stock) bad(`Stok ${p.name} tersisa ${p.stock}`, 409, 'OUT_OF_STOCK');
  let opts = ci.options;
  if (b.options) opts = JSON.stringify((await priceItem(p, b.options)).sel);
  await q.run(
    'UPDATE cart_items SET qty=?, options=?, note=? WHERE id=?',
    qty, opts, b.note !== undefined ? b.note.slice(0, 200) || null : ci.note, ci.id
  );
  res.json(await cartView(req.user.id));
}));

router.delete('/cart/items/:id', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const ci = await ownCartItem(req);
  await q.run('DELETE FROM cart_items WHERE id=?', ci.id);
  res.json(await cartView(req.user.id));
}));

router.post('/vouchers/check', requireAuth, requireRole('customer'), V.validateBody(V.voucherCheckSchema), asyncHandler(async (req, res) => {
  const cart = await cartView(req.user.id);
  const fee = req.body.floor ? await feeFor(req.body.floor) : 0;
  const r = await applyVoucher(req.body.code, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
  res.json({ ...r, message: `Voucher ${r.voucher} dipakai, hemat ${rp(r.discount)}` });
}));

/* ---------- PESANAN (customer) ---------- */
router.post('/orders', requireAuth, requireRole('customer'), V.validateBody(V.orderCreateSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  const courierNote = b.courier_note ? b.courier_note.slice(0, 200) : null;
  const id = await tx(async () => {
    const cart = await cartView(req.user.id);
    if (!cart.items.length) bad('Keranjang masih kosong');
    const bad1 = cart.items.find(i => i.invalid);
    if (bad1) bad(`${bad1.product.name}: ${bad1.invalid}`, 409);
    const m = await q.get('SELECT m.*, u.active ua FROM merchants m JOIN users u ON u.id=m.owner_id WHERE m.id=?', cart.merchant.id);
    if (!m || !m.open || !m.ua) bad('Kantin sedang tutup', 409);
    const fee = await feeFor(b.floor);
    const v = await applyVoucher(b.voucher, cart.items.map(i => ({ product_id: i.product.id })), cart.subtotal, fee);
    const total = cart.subtotal + fee - v.discount;
    const code = await newCode();
    const t = now();
    const payTimeoutSec = Number(await setting('payment_timeout_sec'));
    const expiresAt = t + payTimeoutSec * 1000;

    const oRes = await q.run(
      `INSERT INTO orders(code,customer_id,merchant_id,type,status,stage,subtotal,delivery_fee,discount,total,voucher_code,floor,room,recipient,courier_note,created_at)
      VALUES(?,?,?,'online','MENUNGGU_PEMBAYARAN','menunggu',?,?,?,?,?,?,?,?,?,?)`,
      code, req.user.id, m.id, cart.subtotal, fee, v.discount, total, v.voucher, b.floor, b.room, b.recipient, courierNote, t
    );
    const oid = Number(oRes.lastInsertRowid);
    for (const i of cart.items) {
      await reserveStock(i.product.id, i.qty);
      await q.run(
        'INSERT INTO order_items(order_id,product_id,name,options_text,options_json,note,qty,unit_price) VALUES(?,?,?,?,?,?,?,?)',
        oid, i.product.id, i.product.name, i.text, JSON.stringify(i.options), i.note, i.qty, i.unit
      );
    }
    const ch = payment.createCharge({ code, total, expiresAt });
    await q.run(
      'INSERT INTO payments(order_id,method,provider,ref,amount,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      oid, ch.method, ch.provider, ch.ref, total, payment.PAYMENT_STATUS.PENDING, t, expiresAt, t
    );
    await q.run('DELETE FROM cart_items WHERE cart_id=(SELECT id FROM carts WHERE user_id=?)', req.user.id);
    return oid;
  });
  res.status(201).json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', id), req.user) });
}));

router.get('/orders', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const f = String(req.query.filter || 'all');
  if (!['all', 'aktif', 'berhasil', 'dibatalkan'].includes(f)) bad('Filter pesanan tidak valid');
  let rows = await q.all('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100', req.user.id);
  if (f === 'berhasil') rows = rows.filter(o => o.status === 'SELESAI');
  if (f === 'dibatalkan') rows = rows.filter(o => o.status === 'DIBATALKAN');
  if (f === 'aktif') rows = rows.filter(o => !TERMINAL.includes(o.status));
  res.json({ orders: await Promise.all(rows.map(o => orderView(o, req.user))) });
}));

router.get('/orders/:id', requireAuth, requireRole('customer', 'merchant', 'courier', 'admin'), asyncHandler(async (req, res) => {
  const oid = V.parseId(req.params.id, 'ID pesanan');
  const o = await q.get('SELECT * FROM orders WHERE id=?', oid);
  if (!o) bad('Pesanan tidak ditemukan', 404);
  if (!(await canSee(req.user, o))) bad('Kamu tidak memiliki akses ke pesanan ini', 403);
  res.json({ order: await orderView(o, req.user) });
}));

async function ownOrder(req) {
  const oid = V.parseId(req.params.id, 'ID pesanan');
  const o = await q.get('SELECT * FROM orders WHERE id=?', oid);
  if (!o) bad('Pesanan tidak ditemukan', 404);
  if (o.customer_id !== req.user.id) bad('Kamu tidak memiliki akses ke pesanan ini', 403);
  return o;
}

router.post('/orders/:id/pay', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  const { idempotent } = await confirmOrderPayment(o.id);
  res.json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', o.id), req.user), idempotent });
}));

router.post('/payments/:id/confirm', requireAuth, requireRole('customer', 'admin'), asyncHandler(async (req, res) => {
  const oid = V.parseId(req.params.id, 'ID pesanan');
  const o = await q.get('SELECT * FROM orders WHERE id=?', oid);
  if (!o) bad('Pesanan tidak ditemukan', 404);
  if (req.user.role === 'customer' && o.customer_id !== req.user.id) bad('Kamu tidak memiliki akses ke pesanan ini', 403);
  const { idempotent } = await confirmOrderPayment(o.id);
  res.json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', o.id), req.user), idempotent });
}));

router.post('/orders/:id/pay/fail', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  if (o.status !== 'MENUNGGU_PEMBAYARAN') bad('Pesanan ini tidak menunggu pembayaran', 409);
  const o2 = await cancelOrder(o.id, 'Pembayaran gagal', payment.PAYMENT_STATUS.FAILED);
  res.json({ order: await orderView(o2, req.user) });
}));

router.post('/orders/:id/cancel', requireAuth, requireRole('customer'), V.validateBody(V.orderCancelSchema), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  if (TERMINAL.includes(o.status)) bad('Pesanan sudah selesai/dibatalkan', 409);
  if (o.status !== 'MENUNGGU_PEMBAYARAN' && (o.food_state >= 2 || o.delivery_stage > 0)) {
    bad('Pesanan sudah diproses kantin/kurir sehingga tidak bisa dibatalkan. Hubungi bantuan jika ada masalah.', 409);
  }
  const o2 = await cancelOrder(o.id, (req.body.reason || 'Dibatalkan oleh pembeli').slice(0, 120));
  res.json({ order: await orderView(o2, req.user) });
}));

router.post('/orders/:id/retry-courier', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  if (o.courier_id || TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Tidak perlu mencari kurir lagi', 409);
  await q.run("DELETE FROM deliveries WHERE order_id=? AND status IN('rejected','expired')", o.id);
  await q.run("UPDATE orders SET courier_search='' WHERE id=?", o.id);
  await dispatch(o.id);
  res.json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', o.id), req.user) });
}));

router.post('/orders/:id/rate', requireAuth, requireRole('customer'), V.validateBody(V.rateSchema), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  const b = req.body;
  if (o.status !== 'SELESAI') bad('Rating hanya bisa diberikan setelah pesanan selesai', 409);
  if (await q.get('SELECT 1 x FROM ratings WHERE order_id=?', o.id)) bad('Pesanan ini sudah dinilai', 409);
  await tx(async () => {
    await q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'merchant',?,?,?)", o.id, o.merchant_id, b.merchant_stars, now());
    if (o.courier_id) {
      await q.run("INSERT INTO ratings(order_id,target_type,target_id,stars,created_at) VALUES(?,'courier',?,?,?)", o.id, o.courier_id, b.courier_stars, now());
      await q.run('UPDATE courier_profiles SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE user_id=?', b.courier_stars, o.courier_id);
    }
    if (b.review) await q.run('INSERT INTO reviews(order_id,customer_id,text,created_at) VALUES(?,?,?,?)', o.id, req.user.id, b.review.slice(0, 300), now());
    await q.run('UPDATE merchants SET rating_avg=ROUND((rating_avg*rating_count+?)/(rating_count+1),2), rating_count=rating_count+1 WHERE id=?', b.merchant_stars, o.merchant_id);
  });
  res.json({ ok: true });
}));

router.post('/orders/:id/reorder', requireAuth, requireRole('customer'), asyncHandler(async (req, res) => {
  const o = await ownOrder(req);
  const cart = await q.get('SELECT id FROM carts WHERE user_id=?', req.user.id);
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
  res.json({ added, skipped });
}));

/* ---------- KURIR ---------- */
router.post('/courier/online', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const on = req.body?.online ? 1 : 0;
  await q.run('UPDATE courier_profiles SET online=? WHERE user_id=?', on, req.user.id);
  if (!on) await q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE courier_id=? AND status='offered'", now(), req.user.id);
  if (on) await tick();
  res.json({ online: !!on });
}));

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

router.get('/courier/offer', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  res.json({ offer: await offerFor(req.user.id) });
}));

router.post('/courier/offers/:id/accept', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const offerId = V.parseId(req.params.id, 'ID tawaran');
  const oid = await tx(async () => {
    const d = (await q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered' AND expires_at>?", offerId, req.user.id, now()))
      || bad('Tawaran sudah kedaluwarsa atau diambil kurir lain', 409);
    const r = await q.run("UPDATE orders SET courier_id=?, courier_search='' WHERE id=? AND courier_id IS NULL AND status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')", req.user.id, d.order_id);
    if (r.changes !== 1) bad('Pesanan sudah diambil kurir lain atau dibatalkan', 409);
    await q.run("UPDATE deliveries SET status='accepted', responded_at=? WHERE id=?", now(), d.id);
    const o = await refresh(d.order_id);
    const merch = await q.get('SELECT name FROM merchants WHERE id=?', o.merchant_id);
    await notify(o.customer_id, 'Kurir ditemukan', `${req.user.name} akan mengantar pesananmu.`, `#/order/${o.id}`);
    await notify(await ownerOfMerchant(o.merchant_id), 'Kurir ditemukan', `${req.user.name} akan mengambil ${o.code}.`, '#/m/orders');
    await notify(req.user.id, 'Pesanan diterima', `${o.code}: ambil di ${merch.name}, antar ke Lantai ${o.floor} Ruang ${o.room}.`, '#/c/active');
    return o.id;
  });
  res.json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', oid), req.user) });
}));

router.post('/courier/offers/:id/reject', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const offerId = V.parseId(req.params.id, 'ID tawaran');
  const d = (await q.get("SELECT * FROM deliveries WHERE id=? AND courier_id=? AND status='offered'", offerId, req.user.id))
    || bad('Tawaran tidak ditemukan', 404);
  await q.run("UPDATE deliveries SET status='rejected', responded_at=? WHERE id=?", now(), d.id);
  await dispatch(d.order_id);
  res.json({ ok: true });
}));

router.get('/courier/orders', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const hist = req.query.history === '1';
  const rows = await q.all(
    `SELECT * FROM orders WHERE courier_id=? AND status ${hist ? "IN('SELESAI','DIBATALKAN')" : "NOT IN('SELESAI','DIBATALKAN')"} ORDER BY id DESC LIMIT 100`,
    req.user.id
  );
  res.json({ orders: await Promise.all(rows.map(o => orderView(o, req.user))) });
}));

async function courierOrder(req) {
  const oid = V.parseId(req.params.id, 'ID pesanan');
  return (await q.get('SELECT * FROM orders WHERE id=? AND courier_id=?', oid, req.user.id)) || bad('Pesanan tidak ditemukan', 404);
}

router.post('/courier/orders/:id/arrived', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const o = await courierOrder(req);
  if (TERMINAL.includes(o.status) || o.delivery_stage !== 0) bad('Status pesanan tidak sesuai', 409);
  await q.run('UPDATE orders SET delivery_stage=1 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(await ownerOfMerchant(o.merchant_id), 'Kurir sudah di kantin', `Kurir menunggu ${o.code}.`, '#/m/orders');
  await notify(o.customer_id, 'Kurir mengambil pesanan', `Kurir sudah tiba di kantin untuk ${o.code}.`, `#/order/${o.id}`);
  res.json({ ok: true });
}));

router.post('/courier/orders/:id/pickup', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const o = await courierOrder(req);
  if (TERMINAL.includes(o.status) || o.delivery_stage > 1) bad('Status pesanan tidak sesuai', 409);
  if (o.food_state < 3) bad('Makanan belum ditandai siap oleh kantin', 409);
  await q.run('UPDATE orders SET delivery_stage=2 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Pesanan sedang diantar', `${o.code} dalam pengantaran ke Lantai ${o.floor} Ruang ${o.room}.`, `#/order/${o.id}`);
  await notify(await ownerOfMerchant(o.merchant_id), 'Kurir sudah mengambil makanan', o.code, '#/m/orders');
  res.json({ ok: true });
}));

router.post('/courier/orders/:id/complete', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const o = await courierOrder(req);
  if (o.status !== 'DALAM_PENGANTARAN') bad('Pesanan belum dalam pengantaran', 409);
  payment.assertOrderStageTransition(payment.deriveOrderStage(o.status), payment.ORDER_STAGE.SELESAI);
  const r = await q.run("UPDATE orders SET status='SELESAI', stage='selesai', completed_at=? WHERE id=? AND status='DALAM_PENGANTARAN'", now(), o.id);
  if (r.changes !== 1) bad('Pesanan sudah selesai', 409);
  await settle(o.id);
  await notify(o.customer_id, 'Pesanan selesai', `${o.code} sudah sampai. Beri rating untuk kantin dan kurir ya.`, `#/order/${o.id}`);
  await notify(req.user.id, 'Pendapatan masuk', `+${rp(o.delivery_fee)} dari ${o.code}`, '#/c/earnings');
  res.json({ ok: true });
}));

router.get('/courier/dashboard', requireAuth, requireRole('courier'), asyncHandler(async (req, res) => {
  const cp = await q.get('SELECT * FROM courier_profiles WHERE user_id=?', req.user.id);
  const w = await walletInfo(req.user.id);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const done = (await q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI' AND completed_at>=?", req.user.id, start.getTime())).n;
  const total = (await q.get("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='SELESAI'", req.user.id)).n;
  const active = await q.all("SELECT delivery_fee FROM orders WHERE courier_id=? AND status NOT IN('SELESAI','DIBATALKAN')", req.user.id);
  res.json({
    online: !!cp.online,
    rating_avg: cp.rating_avg,
    rating_count: cp.rating_count,
    today_done: done,
    total_done: total,
    active: active.length,
    earned_today: w.today,
    estimate_today: w.today + active.reduce((s, a) => s + a.delivery_fee, 0),
    balance: w.balance,
  });
}));

router.get('/wallet', requireAuth, requireRole('courier', 'merchant', 'admin', 'customer'), asyncHandler(async (req, res) => {
  res.json(await walletInfo(req.user.id));
}));

/* ---------- MERCHANT / STAFF KANTIN ---------- */
router.get('/m/store', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  res.json({
    merchant: { ...(await merchantOf(req.user)) },
    categories: await q.all('SELECT * FROM categories ORDER BY id'),
  });
}));

router.put('/m/store', requireAuth, requireRole('merchant'), V.validateBody(V.storeSchema), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const b = req.body;
  await q.run(
    'UPDATE merchants SET name=?, description=?, location=?, open=?, eta_min=? WHERE id=?',
    b.name, b.description, b.location, b.open ? 1 : 0, b.eta_min, m.id
  );
  res.json({ merchant: await merchantOf(req.user) });
}));

router.get('/m/products', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const raw = await q.all('SELECT * FROM products WHERE merchant_id=? AND deleted=0 ORDER BY id', m.id);
  res.json({
    products: await Promise.all(raw.map(p => productView(p))),
    categories: await q.all('SELECT * FROM categories ORDER BY id'),
  });
}));

async function prepareProductPayload(b) {
  if (b.image.startsWith('data:')) {
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(b.image)) bad('Format foto harus PNG/JPG/WEBP/GIF');
    if (b.image.length > 2_500_000) bad('Ukuran foto maksimal ±1,8 MB');
  } else if (!/^[a-z]{3,10}$/.test(b.image)) {
    bad('Foto tidak valid');
  }
  await q.run('INSERT OR IGNORE INTO categories(name) VALUES(?)', b.category);
  const categoryId = (await q.get('SELECT id FROM categories WHERE name=?', b.category)).id;
  const gs = [...new Set(b.variants.map(v => v.group_name))];
  const variants = b.variants.map(v => ({
    group_name: v.group_name,
    label: v.label,
    price_delta: v.price_delta,
    required: v.required ? 1 : 0,
    is_default: v.is_default ? 1 : 0,
    show_if: v.show_if || null,
    sort: gs.indexOf(v.group_name),
  }));
  return {
    name: b.name,
    description: b.description,
    base_price: b.base_price,
    stock: b.stock,
    active: b.active ? 1 : 0,
    popular: b.popular ? 1 : 0,
    image: b.image,
    category_id: categoryId,
    variants,
  };
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

async function ownProduct(req, m) {
  const pid = V.parseId(req.params.id, 'ID menu');
  return (await q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', pid, m.id)) || bad('Menu tidak ditemukan', 404);
}

router.post('/m/products', requireAuth, requireRole('merchant'), V.validateBody(V.productSchema), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const id = await saveProduct(m.id, null, await prepareProductPayload(req.body));
  res.status(201).json({ product: await productView(await q.get('SELECT * FROM products WHERE id=?', id)) });
}));

router.put('/m/products/:id', requireAuth, requireRole('merchant'), V.validateBody(V.productSchema), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const p = await ownProduct(req, m);
  await saveProduct(m.id, p.id, await prepareProductPayload(req.body));
  res.json({ product: await productView(await q.get('SELECT * FROM products WHERE id=?', p.id)) });
}));

router.patch('/m/products/:id/stock', requireAuth, requireRole('merchant'), V.validateBody(V.stockPatchSchema), asyncHandler(async (req, res) => {
  const p = await ownProduct(req, await merchantOf(req.user));
  await q.run('UPDATE products SET stock=? WHERE id=?', req.body.stock, p.id);
  res.json({ ok: true });
}));

router.patch('/m/products/:id/active', requireAuth, requireRole('merchant'), V.validateBody(V.activePatchSchema), asyncHandler(async (req, res) => {
  const p = await ownProduct(req, await merchantOf(req.user));
  await q.run('UPDATE products SET active=? WHERE id=?', req.body.active ? 1 : 0, p.id);
  res.json({ ok: true });
}));

router.delete('/m/products/:id', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const p = await ownProduct(req, await merchantOf(req.user));
  await tx(async () => {
    await q.run('UPDATE products SET deleted=1, active=0 WHERE id=?', p.id);
    await q.run('DELETE FROM cart_items WHERE product_id=?', p.id);
    await q.run('DELETE FROM favorites WHERE product_id=?', p.id);
    await q.run('UPDATE vouchers SET active=0 WHERE product_id=?', p.id);
  });
  res.json({ ok: true });
}));

router.get('/m/orders', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const rows = await q.all(
    "SELECT * FROM orders WHERE merchant_id=? AND status!='MENUNGGU_PEMBAYARAN' AND NOT (status='DIBATALKAN' AND paid_at IS NULL AND type='online') ORDER BY id DESC LIMIT 150",
    m.id
  );
  res.json({ orders: await Promise.all(rows.map(o => orderView(o, req.user))) });
}));

async function merchOrder(req) {
  const oid = V.parseId(req.params.id, 'ID pesanan');
  const m = await merchantOf(req.user);
  const o = (await q.get("SELECT * FROM orders WHERE id=? AND merchant_id=? AND type='online'", oid, m.id))
    || bad('Pesanan tidak ditemukan', 404);
  if (TERMINAL.includes(o.status) || o.status === 'MENUNGGU_PEMBAYARAN') bad('Pesanan tidak bisa diubah', 409);
  return o;
}

router.post('/m/orders/:id/accept', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const o = await merchOrder(req);
  if (o.food_state !== 0) bad('Pesanan sudah diterima', 409);
  await q.run('UPDATE orders SET food_state=1 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Pesanan diterima kantin', `${o.code} akan segera disiapkan.`, `#/order/${o.id}`);
  res.json({ ok: true });
}));

router.post('/m/orders/:id/reject', requireAuth, requireRole('merchant'), V.validateBody(V.rejectOrderSchema), asyncHandler(async (req, res) => {
  const o = await merchOrder(req);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan, tidak bisa ditolak', 409);
  await cancelOrder(o.id, 'Ditolak kantin: ' + req.body.reason);
  res.json({ ok: true });
}));

router.post('/m/orders/:id/prepare', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const o = await merchOrder(req);
  if (o.food_state >= 2) bad('Pesanan sudah disiapkan', 409);
  await q.run('UPDATE orders SET food_state=2 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Makanan sedang disiapkan', `${o.code} sedang dimasak.`, `#/order/${o.id}`);
  res.json({ ok: true });
}));

router.post('/m/orders/:id/ready', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const o = await merchOrder(req);
  if (o.food_state !== 2) bad('Tandai "sedang disiapkan" terlebih dahulu', 409);
  payment.assertOrderStageTransition(payment.deriveOrderStage(o.status), payment.ORDER_STAGE.SIAP_DIAMBIL);
  await q.run('UPDATE orders SET food_state=3 WHERE id=?', o.id);
  await refresh(o.id);
  await notify(o.customer_id, 'Makanan siap diambil', `${o.code} siap diambil kurir.`, `#/order/${o.id}`);
  await notify(o.courier_id, 'Makanan siap diambil', `${o.code} sudah siap di kantin.`, '#/c/active');
  res.json({ ok: true });
}));

router.post('/m/offline', requireAuth, requireRole('merchant'), V.validateBody(V.offlineOrderSchema), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const id = await tx(async () => {
    let subtotal = 0;
    const lines = [];
    for (const it of req.body.items) {
      const p = (await q.get('SELECT * FROM products WHERE id=? AND merchant_id=? AND deleted=0', it.product_id, m.id))
        || bad('Menu tidak ditemukan', 404);
      const opts = it.options && Object.keys(it.options).length ? it.options : await defaultOptions(p);
      const pr = await priceItem(p, opts);
      await reserveStock(p.id, it.qty);
      subtotal += pr.unit * it.qty;
      lines.push({ p, qty: it.qty, pr });
    }
    const t = now();
    const oRes = await q.run(
      "INSERT INTO orders(code,merchant_id,type,status,stage,food_state,subtotal,delivery_fee,discount,total,recipient,created_at,paid_at,completed_at,settled) VALUES(?,?,'offline','SELESAI','selesai',3,?,0,0,?,?,?,?,?,1)",
      (await newCode()).replace('CE-', 'OFF-'), m.id, subtotal, subtotal, (req.body.note || 'Pembeli offline').slice(0, 60), t, t, t
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
  res.json({ order: await orderView(await q.get('SELECT * FROM orders WHERE id=?', id), req.user) });
}));

router.get('/m/report', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const mode = req.query.mode === 'monthly' ? 'monthly' : 'daily';
  res.json(await report(mode, (await merchantOf(req.user)).id));
}));

router.get('/m/dashboard', requireAuth, requireRole('merchant'), asyncHandler(async (req, res) => {
  const m = await merchantOf(req.user);
  const w = await walletInfo(req.user.id);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayRows = await q.get("SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) s FROM orders WHERE merchant_id=? AND status='SELESAI' AND COALESCE(completed_at,created_at)>=?", m.id, start.getTime());
  res.json({
    merchant: { ...m, open: !!m.open },
    wallet: { balance: w.balance, today: w.today, month: w.month },
    today_orders: todayRows.n,
    today_sales: todayRows.s,
    pending: (await q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state=0 AND status NOT IN('MENUNGGU_PEMBAYARAN','SELESAI','DIBATALKAN')", m.id)).n,
    processing: (await q.get("SELECT COUNT(*) n FROM orders WHERE merchant_id=? AND type='online' AND food_state IN(1,2,3) AND status NOT IN('SELESAI','DIBATALKAN')", m.id)).n,
    low_stock: await q.all('SELECT name,stock FROM products WHERE merchant_id=? AND deleted=0 AND active=1 AND stock<=5 ORDER BY stock', m.id),
    chart: await report('daily', m.id),
  });
}));

/* ---------- STAFF RINGKASAN (endpoint konsolidasi untuk staff/admin) ---------- */
router.get('/staff/orders', requireAuth, requireRole('staff'), asyncHandler(async (req, res) => {
  let rows = [];
  if (req.user.role === 'admin') {
    rows = await q.all('SELECT * FROM orders ORDER BY id DESC LIMIT 150');
  } else if (req.user.role === 'merchant') {
    const m = await merchantOf(req.user);
    rows = await q.all("SELECT * FROM orders WHERE merchant_id=? AND status!='MENUNGGU_PEMBAYARAN' ORDER BY id DESC LIMIT 150", m.id);
  } else if (req.user.role === 'courier') {
    rows = await q.all('SELECT * FROM orders WHERE courier_id=? ORDER BY id DESC LIMIT 100', req.user.id);
  }
  res.json({ orders: await Promise.all(rows.map(o => orderView(o, req.user))) });
}));

/* ---------- ADMIN ---------- */
router.get('/admin/overview', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const c = async (sql, ...a) => (await q.get(sql, ...a)).n;
  const admin = await q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  res.json({
    customers: await c("SELECT COUNT(*) n FROM users WHERE role='customer' AND deleted=0"),
    couriers: await c("SELECT COUNT(*) n FROM users WHERE role='courier' AND deleted=0"),
    couriers_online: await c("SELECT COUNT(*) n FROM courier_profiles cp JOIN users u ON u.id=cp.user_id WHERE cp.online=1 AND u.active=1 AND u.deleted=0"),
    merchants: await c("SELECT COUNT(*) n FROM merchants m JOIN users u ON u.id=m.owner_id WHERE u.deleted=0"),
    orders: await c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('MENUNGGU_PEMBAYARAN') AND NOT(status='DIBATALKAN' AND paid_at IS NULL)"),
    orders_active: await c("SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN','MENUNGGU_PEMBAYARAN')"),
    transactions: await c("SELECT COUNT(*) n FROM payments WHERE LOWER(status) IN('paid','refunded')"),
    gross: (await q.get("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='SELESAI'")).n,
    platform_balance: admin ? (await walletInfo(admin.id)).balance : 0,
    complaints_open: await c("SELECT COUNT(*) n FROM complaints WHERE status='baru'"),
    chart: await report('daily', null),
  });
}));

router.get('/admin/users', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { role, q: qs, status } = req.query;
  let sql = `SELECT u.id,u.username,u.name,u.phone,u.role,u.active,u.created_at,
    (SELECT online FROM courier_profiles WHERE user_id=u.id) online, (SELECT rating_avg FROM courier_profiles WHERE user_id=u.id) rating,
    (SELECT name FROM merchants WHERE owner_id=u.id) store,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id OR o.courier_id=u.id OR o.merchant_id=(SELECT id FROM merchants WHERE owner_id=u.id)) orders
    FROM users u WHERE u.deleted=0`;
  const a = [];
  if (role) { sql += ' AND u.role=?'; a.push(String(role)); }
  if (status === 'active') sql += ' AND u.active=1';
  if (status === 'inactive') sql += ' AND u.active=0';
  if (qs) { sql += ' AND (u.username LIKE ? OR u.name LIKE ?)'; a.push(`%${qs}%`, `%${qs}%`); }
  res.json({ users: await q.all(sql + ' ORDER BY u.id', ...a) });
}));

async function targetUser(req) {
  const uid = V.parseId(req.params.id, 'ID pengguna');
  const u = (await q.get('SELECT * FROM users WHERE id=? AND deleted=0', uid)) || bad('Pengguna tidak ditemukan', 404);
  if (u.role === 'admin') bad('Akun admin tidak bisa diubah dari sini', 403);
  return u;
}

const hasActiveOrders = async u =>
  (await q.get("SELECT COUNT(*) n FROM orders WHERE status NOT IN('SELESAI','DIBATALKAN') AND (customer_id=? OR courier_id=? OR merchant_id=(SELECT id FROM merchants WHERE owner_id=?))", u.id, u.id, u.id)).n > 0;

router.post('/admin/users/:id/active', requireAuth, requireRole('admin'), V.validateBody(V.activePatchSchema), asyncHandler(async (req, res) => {
  const u = await targetUser(req);
  const on = req.body.active ? 1 : 0;
  if (!on && (await hasActiveOrders(u))) bad('Pengguna masih memiliki pesanan berjalan', 409);
  await q.run('UPDATE users SET active=? WHERE id=?', on, u.id);
  if (!on) {
    await q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id);
  }
  await notify(u.id, on ? 'Akun diaktifkan kembali' : 'Akun dinonaktifkan', on ? 'Kamu bisa menggunakan Campus Eats lagi.' : 'Hubungi admin untuk informasi lebih lanjut.');
  res.json({ ok: true });
}));

router.delete('/admin/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const u = await targetUser(req);
  if (u.role === 'customer') bad('Akun pembeli cukup dinonaktifkan, tidak dihapus', 403);
  if (await hasActiveOrders(u)) bad('Pengguna masih memiliki pesanan berjalan', 409);
  await tx(async () => {
    await q.run("UPDATE users SET deleted=1, active=0, username=username||'#del'||id WHERE id=?", u.id);
    await q.run('UPDATE courier_profiles SET online=0 WHERE user_id=?', u.id);
    await q.run('UPDATE merchants SET open=0 WHERE owner_id=?', u.id);
  });
  res.json({ ok: true });
}));

router.get('/admin/orders', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  let sql = 'SELECT o.*, m.name merchant_name, (SELECT name FROM users WHERE id=o.customer_id) customer_name, (SELECT name FROM users WHERE id=o.courier_id) courier_name FROM orders o JOIN merchants m ON m.id=o.merchant_id WHERE 1=1';
  const a = [];
  if (req.query.status) { sql += ' AND o.status=?'; a.push(String(req.query.status)); }
  if (req.query.q) { sql += ' AND o.code LIKE ?'; a.push(`%${req.query.q}%`); }
  res.json({ orders: await q.all(sql + ' ORDER BY o.id DESC LIMIT 200', ...a) });
}));

router.get('/admin/transactions', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const payments = await q.all('SELECT p.*, o.code FROM payments p JOIN orders o ON o.id=p.order_id ORDER BY p.id DESC LIMIT 200');
  res.json({
    payments: payments.map(p => ({ ...p, status: payment.normalizePaymentStatus(p.status) })),
    wallet: await q.all("SELECT wt.*, u.name user_name, u.role FROM wallet_transactions wt JOIN wallets w ON w.id=wt.wallet_id JOIN users u ON u.id=w.user_id WHERE wt.type!='refund' ORDER BY wt.id DESC LIMIT 200"),
  });
}));

router.get('/admin/report', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const mode = req.query.mode === 'monthly' ? 'monthly' : 'daily';
  res.json({
    ...(await report(mode, null)),
    complaints: await q.all('SELECT c.*, u.name user_name, u.role, o.code FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN orders o ON o.id=c.order_id ORDER BY c.id DESC LIMIT 100'),
  });
}));

router.post('/admin/complaints/:id/resolve', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const cid = V.parseId(req.params.id, 'ID pengaduan');
  await q.run("UPDATE complaints SET status='selesai' WHERE id=?", cid);
  res.json({ ok: true });
}));

router.get('/admin/settings', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const fees = Object.fromEntries(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(async f => [f, await feeFor(f)])));
  res.json({
    fees,
    commission_pct: Number(await setting('commission_pct')),
    offer_timeout_sec: Number(await setting('offer_timeout_sec')),
    payment_timeout_sec: Number(await setting('payment_timeout_sec')),
    vouchers: await q.all('SELECT * FROM vouchers ORDER BY rowid'),
  });
}));

router.put('/admin/settings', requireAuth, requireRole('admin'), V.validateBody(V.adminSettingsSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  for (let f = 1; f <= 9; f++) {
    if (b.fees[String(f)] === undefined && b.fees[f] === undefined) {
      bad(`Ongkir lantai ${f} wajib diisi`, 400, 'VALIDATION_ERROR');
    }
  }
  await tx(async () => {
    for (let f = 1; f <= 9; f++) {
      const val = b.fees[String(f)] ?? b.fees[f];
      await q.run('UPDATE settings SET value=? WHERE key=?', String(val), 'fee_' + f);
    }
    await q.run("UPDATE settings SET value=? WHERE key='commission_pct'", String(b.commission_pct));
    await q.run("UPDATE settings SET value=? WHERE key='offer_timeout_sec'", String(b.offer_timeout_sec));
    await q.run("UPDATE settings SET value=? WHERE key='payment_timeout_sec'", String(b.payment_timeout_sec));
  });
  res.json({ ok: true });
}));

router.post('/admin/vouchers', requireAuth, requireRole('admin'), V.validateBody(V.voucherCreateSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  if (await q.get('SELECT 1 x FROM vouchers WHERE code=?', b.code)) bad('Kode sudah ada', 409);
  if (b.type === 'percent' && b.value > 100) bad('Nilai diskon persen maksimal 100', 400, 'VALIDATION_ERROR');
  await q.run(
    'INSERT INTO vouchers(code,description,type,value,min_subtotal,product_id) VALUES(?,?,?,?,?,?)',
    b.code, b.description, b.type, b.value, b.min_subtotal, b.product_id ?? null
  );
  res.status(201).json({ ok: true });
}));

router.post('/admin/vouchers/:code/toggle', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const r = await q.run('UPDATE vouchers SET active=1-active WHERE code=?', code);
  if (r.changes === 0) bad('Voucher tidak ditemukan', 404);
  res.json({ ok: true });
}));

router.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint tidak ditemukan',
    },
  });
});

module.exports = { router, tick, AppError };
