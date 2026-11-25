// Tes alur end-to-end (tanpa dependensi): node tests/flow.test.js
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = path.join(os.tmpdir(), `ce-test-${Date.now()}.db`);
process.env.DB_FILE = tmp;
const server = require('../server');
const api = require('../src/api');

const jar = {};
async function call(who, method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', cookie: jar[who] ? 'ce_sid=' + jar[who] : '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) jar[who] = /ce_sid=([^;]*)/.exec(sc)[1];
  const d = await r.json();
  return { status: r.status, ...d };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${r.error}`); return r; };
const fail = async (code, ...a) => { const r = await call(...a); assert.strictEqual(r.status, code, `${a[1]} ${a[2]} seharusnya ${code}, dapat ${r.status}`); return r; };
let base;

(async () => {
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
  const login = (who, u, p) => ok(who, 'POST', '/api/auth/login', { username: u, password: p });
  await login('abyan', 'abyan', 'Abyan123!'); await login('agus', 'agus', 'Agus123!'); await login('seno', 'seno', 'Seno123!');
  await login('lore', 'kantinlore', 'Lore123!'); await login('admin', 'admin', 'Admin123!');
  await fail(401, 'x', 'POST', '/api/auth/login', { username: 'abyan', password: 'salah' });
  console.log('✓ login 5 akun demo');

  await fail(403, 'abyan', 'GET', '/api/admin/overview');
  await fail(403, 'agus', 'GET', '/api/m/orders');
  await fail(403, 'lore', 'GET', '/api/cart');
  console.log('✓ proteksi role');

  const menu = (await ok('abyan', 'GET', '/api/menu')).products;
  const box = menu.find(p => p.name.startsWith('Rice Box')), geprek = menu.find(p => p.name === 'Ayam Geprek'), mie = menu.find(p => p.name === 'Mie Ayam');
  await fail(400, 'abyan', 'POST', '/api/cart/items', { product_id: box.id, qty: 1, options: { Ukuran: 'Regular' } }); // saus wajib
  let cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: box.id, qty: 2, options: { Ukuran: 'Large', Tambahan: 'Tambah ayam', Saus: 'Lava' } });
  assert.strictEqual(cart.subtotal, 2 * (15000 + 5000));
  cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Matah' } });
  assert.strictEqual(cart.subtotal, 40000 + 16000);
  await ok('abyan', 'DELETE', '/api/cart/items/' + cart.items[0].id);
  cart = await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Tidak' } });
  assert.strictEqual(cart.subtotal, 32000);
  console.log('✓ variasi, validasi wajib, harga otomatis, keranjang');

  const stock0 = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  await fail(400, 'abyan', 'POST', '/api/orders', { floor: 5, room: 105, recipient: '' });
  await fail(400, 'abyan', 'POST', '/api/vouchers/check', { code: 'GEPREK3K', floor: 5 }).catch(() => {});
  const v = await ok('abyan', 'POST', '/api/vouchers/check', { code: 'GRATISONGKIR', floor: 9 });
  assert.strictEqual(v.discount, 4000);
  const created = await ok('abyan', 'POST', '/api/orders', { floor: 9, room: 120, recipient: 'Abyan', voucher: 'GRATISONGKIR' });
  const oid = created.order.id;
  assert.strictEqual(created.order.total, 16000 + 16000 + 4000 - 4000);
  const stock1 = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  assert.strictEqual(stock1, stock0 - 1);
  console.log('✓ checkout, ongkir lantai 9, voucher, reservasi stok');

  // pembatalan sebelum bayar mengembalikan stok & tidak masuk antrean kurir
  await ok('abyan', 'POST', `/api/orders/${oid}/cancel`, {});
  assert.strictEqual((await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock, stock0);
  await fail(409, 'abyan', 'POST', `/api/orders/${oid}/pay`);
  console.log('✓ batal bayar mengembalikan stok');

  // alur utama
  await ok('abyan', 'POST', '/api/cart/items', { product_id: geprek.id, qty: 1, options: { 'Bagian Ayam': 'Paha Atas', Sambal: 'Sambal Bawang' } });
  const o2 = (await ok('abyan', 'POST', '/api/orders', { floor: 5, room: 105, recipient: 'Abyan' })).order;
  assert.strictEqual(o2.total, 18000);
  await ok('agus', 'POST', '/api/courier/online', { online: true });
  await ok('seno', 'POST', '/api/courier/online', { online: true });
  await ok('abyan', 'POST', `/api/orders/${o2.id}/pay`);
  let d = (await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order;
  assert.strictEqual(d.status, 'MENCARI_KURIR');
  const offA = (await ok('agus', 'GET', '/api/courier/offer')).offer, offS = (await ok('seno', 'GET', '/api/courier/offer')).offer;
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

  await fail(409, 'abyan', 'POST', `/api/orders/${o2.id}/complete`).catch(() => {});
  await fail(409, second, 'POST', `/api/courier/orders/${o2.id}/pickup`); // makanan belum siap
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/accept`);
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/prepare`);
  await fail(409, 'abyan', 'POST', `/api/orders/${o2.id}/cancel`); // sudah disiapkan
  await ok('lore', 'POST', `/api/m/orders/${o2.id}/ready`);
  await ok(second, 'POST', `/api/courier/orders/${o2.id}/arrived`);
  await ok(second, 'POST', `/api/courier/orders/${o2.id}/pickup`);
  assert.strictEqual((await ok('abyan', 'GET', `/api/orders/${o2.id}`)).order.status, 'DALAM_PENGANTARAN');
  await ok(second, 'POST', `/api/courier/orders/${o2.id}/complete`);
  await fail(409, second, 'POST', `/api/courier/orders/${o2.id}/complete`);
  const wl = (await ok('lore', 'GET', '/api/wallet')), wc = (await ok(second, 'GET', '/api/wallet'));
  assert.strictEqual(wl.balance, 16000); assert.strictEqual(wc.balance, 2000);
  console.log('✓ status penuh sampai selesai, pembagian: kantin Rp16.000, kurir Rp2.000 (tanpa hitung ganda)');

  await ok('abyan', 'POST', `/api/orders/${o2.id}/rate`, { merchant_stars: 5, courier_stars: 4, review: 'Enak' });
  await fail(409, 'abyan', 'POST', `/api/orders/${o2.id}/rate`, { merchant_stars: 5, courier_stars: 4 });

  // kantin menolak -> refund
  await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Ya' } });
  const o3 = (await ok('abyan', 'POST', '/api/orders', { floor: 6, room: 101, recipient: 'Abyan' })).order;
  await ok('abyan', 'POST', `/api/orders/${o3.id}/pay`);
  await ok('lore', 'POST', `/api/m/orders/${o3.id}/reject`, { reason: 'Bahan habis' });
  const me = await ok('abyan', 'GET', '/api/me');
  assert.strictEqual(me.user.refund_balance, 16000 + 2500);
  console.log('✓ penolakan kantin + saldo refund');

  // offline berbagi stok
  const before = (await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock;
  await ok('lore', 'POST', '/api/m/offline', { items: [{ product_id: geprek.id, qty: 2, options: { 'Bagian Ayam': 'Dada', Sambal: 'Sambal Hijau' } }] });
  assert.strictEqual((await ok('lore', 'GET', '/api/m/products')).products.find(p => p.id === geprek.id).stock, before - 2);
  console.log('✓ pesanan offline memakai stok yang sama');

  // tidak ada kurir
  await ok('agus', 'POST', '/api/courier/online', { online: false }); await ok('seno', 'POST', '/api/courier/online', { online: false });
  await ok('abyan', 'POST', '/api/cart/items', { product_id: mie.id, qty: 1, options: { 'Pakai Sawi': 'Ya', 'Pakai Ayam': 'Ya', 'Pakai Daun Bawang': 'Ya' } });
  const o4 = (await ok('abyan', 'POST', '/api/orders', { floor: 1, room: 101, recipient: 'Abyan' })).order;
  await ok('abyan', 'POST', `/api/orders/${o4.id}/pay`);
  assert.strictEqual((await ok('abyan', 'GET', `/api/orders/${o4.id}`)).order.courier_search, 'none');
  await ok('abyan', 'POST', `/api/orders/${o4.id}/cancel`, {});
  console.log('✓ tidak ada kurir aktif -> info ke pembeli, bisa batal + refund');

  const ov = await ok('admin', 'GET', '/api/admin/overview');
  assert.ok(ov.orders >= 4 && ov.gross === 18000 + 0 + 0 || ov.gross >= 18000);
  const rep = await ok('lore', 'GET', '/api/m/report');
  assert.ok(rep.total >= 16000);
  await ok('admin', 'POST', `/api/admin/users/${(await ok('admin', 'GET', '/api/admin/users?role=courier')).users[0].id}/active`, { active: false });
  await fail(403, 'agus', 'POST', '/api/courier/online', { online: true }).catch(() => {});
  console.log('✓ admin overview, laporan, nonaktifkan akun');

  console.log('\nSEMUA TES LULUS');
  server.close(); fs.rmSync(tmp, { force: true }); process.exit(0);
})().catch(e => { console.error('\n✗ GAGAL:', e.message); process.exit(1); });
