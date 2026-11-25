// Tes alur end-to-end: node tests/flow.test.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const jwt = require('jsonwebtoken');

const tmp = path.join(os.tmpdir(), `ce-test-${Date.now()}.db`);
process.env.DB_FILE = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long';
process.env.SEED_ADMIN_PASSWORD = 'TestAdminPass!1';
process.env.SEED_CUSTOMER_PASSWORD = 'TestCustomerPass!1';
process.env.SEED_COURIER_PASSWORD = 'TestCourierPass!1';
process.env.SEED_MERCHANT_PASSWORD = 'TestMerchantPass!1';

const { app, initDb, closeDb, stopTick } = require('../server');
const { q } = require('../src/db');

const jar = {};
const tokens = {};
let base;

async function call(who, method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (who && jar[who] && !extraHeaders.Authorization) headers.cookie = 'ce_sid=' + jar[who];
  const r = await fetch(base + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc && who) {
    const m = /ce_sid=([^;]*)/.exec(sc);
    if (m) jar[who] = m[1];
  }
  const d = await r.json().catch(() => ({}));
  if (d.token && who) tokens[who] = d.token;
  return { ...d, bodyStatus: d.status, status: r.status, headers: r.headers };
}

const ok = async (...a) => {
  const r = await call(...a);
  const msg = typeof r.error === 'object' ? r.error.message : r.error;
  assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${msg}`);
  return r;
};

const fail = async (code, ...a) => {
  const r = await call(...a);
  assert.strictEqual(r.status, code, `${a[1]} ${a[2]} seharusnya ${code}, dapat ${r.status}`);
  assert.ok(r.error && typeof r.error === 'object' && r.error.code && r.error.message, 'Format error JSON harus { error: { code, message } }');
  return r;
};

(async () => {
  await initDb();
  const userCountBefore = Number((await q.get('SELECT COUNT(*) AS c FROM users')).c);
  await initDb();
  const userCountAfter = Number((await q.get('SELECT COUNT(*) AS c FROM users')).c);
  assert.strictEqual(userCountBefore, 5);
  assert.strictEqual(userCountAfter, 5);
  console.log('✓ migrasi & seeding idempoten (5 akun bcrypt)');

  const httpServer = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = 'http://127.0.0.1:' + httpServer.address().port;

  // 1. Health & Security headers
  const h = await ok(null, 'GET', '/health');
  assert.strictEqual(h.bodyStatus, 'ok');
  assert.strictEqual(h.db, 'connected');
  assert.strictEqual(h.headers.get('x-content-type-options'), 'nosniff');
  console.log('✓ /health & header keamanan helmet aktif');

  // 2. Register, Login, JWT Bearer + Cookie, Auth 401 & Token Kedaluwarsa
  await fail(401, null, 'GET', '/api/orders');
  await fail(401, null, 'GET', '/api/m/orders');
  const regErr = await fail(400, null, 'POST', '/api/auth/register', { role: 'customer', username: 'x', password: '123', name: 'A' });
  assert.strictEqual(regErr.error.code, 'VALIDATION_ERROR');
  assert.ok(regErr.error.fields);

  const cust2 = await ok('budi', 'POST', '/api/auth/register', {
    role: 'customer',
    username: 'budi_mhs',
    password: 'BudiPassword123',
    name: 'Budi Mahasiswa',
    phone: '081234567890',
  });
  assert.strictEqual(cust2.user.role, 'customer');
  assert.ok(cust2.token);
  const meCookie = await ok('budi', 'GET', '/api/me');
  assert.strictEqual(meCookie.user.username, 'budi_mhs');
  const meBearer = await ok(null, 'GET', '/api/me', undefined, { Authorization: 'Bearer ' + tokens.budi });
  assert.strictEqual(meBearer.user.username, 'budi_mhs');

  const expiredToken = jwt.sign({ sub: String(cust2.user.id), role: 'customer' }, process.env.JWT_SECRET, { expiresIn: -10 });
  const expRes = await fail(401, null, 'GET', '/api/orders', undefined, { Authorization: 'Bearer ' + expiredToken });
  assert.strictEqual(expRes.error.code, 'TOKEN_EXPIRED');
  console.log('✓ register, login, JWT cookie & Bearer, token kedaluwarsa ditolak 401');

  const login = (who, u, p) => ok(who, 'POST', '/api/auth/login', { username: u, password: p });
  await login('abyan', 'abyan', process.env.SEED_CUSTOMER_PASSWORD);
  await login('agus', 'agus', process.env.SEED_COURIER_PASSWORD);
  await login('seno', 'seno', process.env.SEED_COURIER_PASSWORD);
  await login('lore', 'kantinlore', process.env.SEED_MERCHANT_PASSWORD);
  await login('admin', 'admin', process.env.SEED_ADMIN_PASSWORD);
  await fail(401, 'x', 'POST', '/api/auth/login', { username: 'abyan', password: 'salah' });
  console.log('✓ login 5 akun demo');

  // 3. Proteksi role (403)
  await fail(403, 'abyan', 'GET', '/api/admin/overview');
  await fail(403, 'abyan', 'GET', '/api/m/orders');
  await fail(403, 'abyan', 'GET', '/api/staff/orders');
  await fail(403, 'agus', 'GET', '/api/m/orders');
  await fail(403, 'lore', 'GET', '/api/cart');
  await ok('lore', 'GET', '/api/staff/orders');
  console.log('✓ proteksi role (403 untuk customer/role salah)');

  // 4. Menu, Variasi, Keranjang, Validasi & Menu Nonaktif
  const menu = (await ok('abyan', 'GET', '/api/menu')).products;
  const box = menu.find(p => p.name.startsWith('Rice Box'));
  const geprek = menu.find(p => p.name === 'Ayam Geprek');
  const mie = menu.find(p => p.name === 'Mie Ayam');

  // Menu yang dinonaktifkan merchant tidak bisa dipesan customer
  await ok('lore', 'PATCH', `/api/m/products/${box.id}/active`, { active: false });
  await fail(404, 'abyan', 'GET', `/api/products/${box.id}`);
  await fail(404, 'abyan', 'POST', '/api/cart/items', { product_id: box.id, qty: 1, options: { Ukuran: 'Regular', Saus: 'Keju' } });
  await ok('lore', 'PATCH', `/api/m/products/${box.id}/active`, { active: true });
  console.log('✓ menu nonaktif tidak bisa dilihat maupun dipesan customer');

  await fail(400, 'abyan', 'POST', '/api/cart/items', { product_id: box.id, qty: 1, options: { Ukuran: 'Regular' } });
  let cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: box.id, qty: 2, options: { Ukuran: 'Large', Tambahan: 'Tambah ayam', Saus: 'Lava' } });
  assert.strictEqual(cart.subtotal, 2 * (15000 + 5000));
  cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Matah' } });
  assert.strictEqual(cart.subtotal, 40000 + 16000);
  await ok('abyan', 'DELETE', '/api/cart/items/' + cart.items[0].id);
  cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Tidak' } });
  assert.strictEqual(cart.subtotal, 32000);
  console.log('✓ variasi, validasi wajib, harga otomatis di server, keranjang');

  // 5. Stok tidak cukup ditolak (saat tambah ke keranjang maupun saat checkout)
  const stock0 = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  await ok('lore', 'PATCH', `/api/m/products/${geprek.id}/stock`, { stock: 1 });
  await fail(409, 'budi', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 2, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Matah' } });
  await ok('budi', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Matah' } });
  await ok('lore', 'PATCH', `/api/m/products/${geprek.id}/stock`, { stock: 0 });
  await fail(409, 'budi', 'POST', '/api/orders', { floor: 3, room: 103, recipient: 'Budi' });
  await ok('lore', 'PATCH', `/api/m/products/${geprek.id}/stock`, { stock: stock0 });
  console.log('✓ stok tidak cukup / habis ditolak (409)');

  // 6. Validasi checkout, voucher, ongkir, harga server-side, reservasi stok
  const badOrder = await fail(400, 'abyan', 'POST', '/api/orders', { floor: 5, room: 105, recipient: '' });
  assert.strictEqual(badOrder.error.code, 'VALIDATION_ERROR');
  await fail(400, 'abyan', 'GET', '/api/orders/bukan-angka');
  await fail(400, 'abyan', 'POST', '/api/vouchers/check', { code: 'KODEPALSU', floor: 5 });
  const vGeprek = await ok('abyan', 'POST', '/api/vouchers/check', { code: 'GEPREK3K', floor: 5 });
  assert.strictEqual(vGeprek.discount, 3000);
  const v = await ok('abyan', 'POST', '/api/vouchers/check', { code: 'GRATISONGKIR', floor: 9 });
  assert.strictEqual(v.discount, 4000);

  // Kirim total palsu dari client -> harus diabaikan server
  const created = await ok('abyan', 'POST', '/api/orders', {
    floor: 9, room: 120, recipient: 'Abyan', voucher: 'GRATISONGKIR', total: 100, price: 1,
  });
  const oid = created.order.id;
  assert.strictEqual(created.order.total, 16000 + 16000 + 4000 - 4000);
  assert.strictEqual(created.order.stage, 'menunggu');
  assert.strictEqual(created.order.payment.status, 'pending');
  const stock1 = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  assert.strictEqual(stock1, stock0 - 1);
  console.log('✓ checkout, total server-side, payment pending, reservasi stok');

  // 7. Isolasi kepemilikan: Customer B tidak boleh mengakses order Customer A
  await fail(403, 'budi', 'GET', `/api/orders/${oid}`);
  await fail(403, 'budi', 'POST', `/api/orders/${oid}/pay`);
  console.log('✓ isolasi kepemilikan: Customer B dilarang akses order Customer A (403)');

  // 8. Pembatalan sebelum bayar & payment failed mengembalikan stok
  await ok('abyan', 'POST', `/api/orders/${oid}/cancel`, {});
  assert.strictEqual((await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock, stock0);
  await fail(409, 'abyan', 'POST', `/api/orders/${oid}/pay`);

  await ok('abyan', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Matah' } });
  const oFail = (await ok('abyan', 'POST', '/api/orders', { floor: 2, room: 102, recipient: 'Abyan' })).order;
  const failedOrder = (await ok('abyan', 'POST', `/api/orders/${oFail.id}/pay/fail`)).order;
  assert.strictEqual(failedOrder.payment.status, 'failed');
  assert.strictEqual(failedOrder.stage, 'dibatalkan');
  assert.strictEqual((await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock, stock0);
  console.log('✓ batal bayar & payment failed mengembalikan stok');

  // 9. Alur utama + idempotensi pembayaran
  await ok('abyan', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Paha Atas', Sambal: 'Sambal Bawang' } });
  const o2 = (await ok('abyan', 'POST', '/api/orders', { floor: 5, room: 105, recipient: 'Abyan' })).order;
  assert.strictEqual(o2.total, 18000);
  await ok('agus', 'POST', '/api/courier/online', { online: true });
  await ok('seno', 'POST', '/api/courier/online', { online: true });

  const pay1 = await ok('abyan', 'POST', `/api/orders/${o2.id}/pay`);
  assert.strictEqual(pay1.idempotent, false);
  assert.strictEqual(pay1.order.payment.status, 'paid');
  assert.strictEqual(pay1.order.stage, 'diproses');
  const notifCountAfterPay1 = Number((await q.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id=?', o2.customer_id)).c);

  // Panggil konfirmasi pembayaran kedua kali -> idempoten (200, tidak gandakan notifikasi)
  const pay2 = await ok('abyan', 'POST', `/api/orders/${o2.id}/pay`);
  assert.strictEqual(pay2.idempotent, true);
  assert.strictEqual(pay2.order.payment.status, 'paid');
  const notifCountAfterPay2 = Number((await q.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id=?', o2.customer_id)).c);
  assert.strictEqual(notifCountAfterPay2, notifCountAfterPay1);
  console.log('✓ konfirmasi pembayaran idempoten (tidak menggandakan efek)');

  let d = (await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order;
  assert.strictEqual(d.status, 'MENCARI_KURIR');
  const offA = (await ok('agus', 'GET', '/api/courier/offer')).offer;
  const offS = (await ok('seno', 'GET', '/api/courier/offer')).offer;
  assert.ok(!!offA !== !!offS, 'tepat satu kurir mendapat tawaran');
  const [first, firstName, second] = offA ? [offA, 'agus', 'seno'] : [offS, 'seno', 'agus'];
  await ok(firstName, 'POST', `/api/courier/offers/${first.id}/reject`);
  const off2 = (await ok(second, 'GET', '/api/courier/offer')).offer;
  assert.ok(off2, 'ditawarkan ke kurir berikutnya setelah ditolak');
  await ok(second, 'POST', `/api/courier/offers/${off2.id}/accept`);
  await fail(409, firstName, 'POST', `/api/courier/offers/${first.id}/accept`);
  d = (await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order;
  assert.strictEqual(d.status, 'KURIR_DITEMUKAN');
  console.log('✓ pencarian kurir, tolak -> kurir lain, satu pesanan satu kurir');

  await fail(404, 'abyan', 'POST', `/api/orders/${o2.id}/complete`);
  await fail(409, second, 'POST', `/api/courier/orders/${o2.id}/pickup`);
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/accept`);
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/prepare`);
  await fail(409, 'abyan', 'POST', `/api/orders/${o2.id}/cancel`);
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/ready`);

  // Konsistensi status customer vs merchant dashboard
  const merchView = (await ok('lore', 'GET', '/api/m/orders')).orders.find(x => x.id === o2.id);
  const custView = (await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order;
  assert.strictEqual(merchView.status, custView.status);
  assert.strictEqual(merchView.stage, 'siap_diambil');
  assert.strictEqual(custView.stage, 'siap_diambil');
  assert.strictEqual(merchView.payment.status, custView.payment.status);

  await ok(second, 'POST', `/api/courier/orders/${o2.id}/arrived`);
  await ok(second, 'POST', `/api/courier/orders/${o2.id}/pickup`);
  assert.strictEqual((await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order.status, 'DALAM_PENGANTARAN');
  await ok(second, 'POST', `/api/courier/orders/${o2.id}/complete`);
  await fail(409, second, 'POST', `/api/courier/orders/${o2.id}/complete`);
  assert.strictEqual((await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order.stage, 'selesai');

  const wl = await ok('lore', 'GET', '/api/wallet');
  const wc = await ok(second, 'GET', '/api/wallet');
  assert.strictEqual(wl.balance, 16000);
  assert.strictEqual(wc.balance, 2000);
  console.log('✓ konsistensi status customer & staff sampai selesai, saldo terbagi benar');

  await ok('abyan', 'POST', `/api/orders/${o2.id}/rate`, { merchant_stars: 5, courier_stars: 4, review: 'Enak' });
  await fail(409, 'abyan', 'POST', `/api/orders/${o2.id}/rate`, { merchant_stars: 5, courier_stars: 4 });

  // 10. Kantin menolak -> refund
  await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Ya' } });
  const o3 = (await ok('abyan', 'POST', '/api/orders', { floor: 6, room: 101, recipient: 'Abyan' })).order;
  await ok('abyan', 'POST', `/api/orders/${o3.id}/pay`);
  await ok('lore', 'POST', `/api/m/orders/${o3.id}/reject`, { reason: 'Bahan habis' });
  const me = await ok('abyan', 'GET', '/api/me');
  assert.strictEqual(me.user.refund_balance, 16000 + 2500);
  console.log('✓ penolakan kantin + saldo refund');

  // 11. Pesanan offline memakai stok yang sama
  const before = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  await ok('lore', 'POST', '/api/m/offline', { items: [{ product_id: geprek.id, qty: 2, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Hijau' } }] });
  assert.strictEqual((await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock, before - 2);
  console.log('✓ pesanan offline memakai stok yang sama');

  // 12. Tidak ada kurir aktif
  await ok('agus', 'POST', '/api/courier/online', { online: false });
  await ok('seno', 'POST', '/api/courier/online', { online: false });
  await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Ya' } });
  const o4 = (await ok('abyan', 'POST', '/api/orders', { floor: 1, room: 101, recipient: 'Abyan' })).order;
  await ok('abyan', 'POST', `/api/orders/${o4.id}/pay`);
  assert.strictEqual((await ok('abyan', 'GET', `/api/orders/${o4.id}`)).order.courier_search, 'none');
  await ok('abyan', 'POST', `/api/orders/${o4.id}/cancel`, {});
  console.log('✓ tidak ada kurir aktif -> info ke pembeli, bisa batal + refund');

  // 13. Admin overview, laporan, nonaktifkan akun -> JWT langsung tertolak
  const ov = await ok('admin', 'GET', '/api/admin/overview');
  assert.ok(ov.orders >= 4 && ov.gross >= 18000);
  const rep = await ok('lore', 'GET', '/api/m/report');
  assert.ok(rep.total >= 16000);
  const couriers = (await ok('admin', 'GET', '/api/admin/users?role=courier')).users;
  await ok('admin', 'POST', `/api/admin/users/${couriers[0].id}/active`, { active: false });
  await fail(403, 'agus', 'POST', '/api/courier/online', { online: true });
  console.log('✓ admin overview, laporan, nonaktifkan akun');

  console.log('\nSEMUA TES LULUS');
  stopTick();
  await new Promise(r => httpServer.close(r));
  await closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix, { force: true }); } catch {}
  }
  process.exit(0);
})().catch(async e => {
  console.error('\n✗ GAGAL:', e);
  stopTick();
  try { await closeDb(); } catch {}
  setTimeout(() => process.exit(1), 50);
});
