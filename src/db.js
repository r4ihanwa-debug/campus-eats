const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(dir, 'campus-eats.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

const q = {
  get: (s, ...a) => db.prepare(s).get(...a),
  all: (s, ...a) => db.prepare(s).all(...a),
  run: (s, ...a) => db.prepare(s).run(...a),
};
let depth = 0;
function tx(fn) {
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}
const now = () => Date.now();

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const t = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(h, 'hex');
  return b.length === t.length && crypto.timingSafeEqual(b, t);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('customer','courier','merchant','admin')),
  name TEXT NOT NULL, phone TEXT, active INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customer_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, default_floor INTEGER, default_room INTEGER);
CREATE TABLE IF NOT EXISTS courier_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, online INTEGER NOT NULL DEFAULT 0, rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0, last_offer_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS merchants(id INTEGER PRIMARY KEY, owner_id INTEGER UNIQUE NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT, location TEXT, open INTEGER NOT NULL DEFAULT 1, eta_min INTEGER NOT NULL DEFAULT 10, rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL, description TEXT, base_price INTEGER NOT NULL, image TEXT, stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, popular INTEGER NOT NULL DEFAULT 0, rating REAL NOT NULL DEFAULT 4.7, sold INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS product_variants(
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL, label TEXT NOT NULL, price_delta INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, show_if TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS carts(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS cart_items(id INTEGER PRIMARY KEY, cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), options TEXT NOT NULL DEFAULT '{}', note TEXT, qty INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, PRIMARY KEY(user_id,product_id));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES users(id), merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  type TEXT NOT NULL DEFAULT 'online', status TEXT NOT NULL, food_state INTEGER NOT NULL DEFAULT 0, delivery_stage INTEGER NOT NULL DEFAULT 0,
  courier_id INTEGER REFERENCES users(id), courier_search TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, voucher_code TEXT,
  floor INTEGER, room INTEGER, recipient TEXT, courier_note TEXT, cancel_reason TEXT, settled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, paid_at INTEGER, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, options_text TEXT, options_json TEXT, note TEXT, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, courier_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, offered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, responded_at INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, method TEXT NOT NULL, provider TEXT NOT NULL, ref TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER);
CREATE TABLE IF NOT EXISTS wallets(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE, balance INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wallet_transactions(id INTEGER PRIMARY KEY, wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE, order_id INTEGER REFERENCES orders(id), type TEXT NOT NULL, amount INTEGER NOT NULL, description TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ratings(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), created_at INTEGER NOT NULL, UNIQUE(order_id,target_type));
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE, customer_id INTEGER NOT NULL REFERENCES users(id), text TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT, link TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vouchers(code TEXT PRIMARY KEY COLLATE NOCASE, description TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('fixed','free_shipping','percent')), value INTEGER NOT NULL DEFAULT 0, min_subtotal INTEGER NOT NULL DEFAULT 0, product_id INTEGER REFERENCES products(id), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), order_id INTEGER REFERENCES orders(id), subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'baru', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id,id);
`);

function createUser({ username, password, role, name, phone }) {
  const id = q.run('INSERT INTO users(username,password_hash,role,name,phone,created_at) VALUES(?,?,?,?,?,?)',
    username, hashPw(password), role, name, phone || null, now()).lastInsertRowid;
  q.run('INSERT INTO wallets(user_id) VALUES(?)', id);
  if (role === 'customer') { q.run('INSERT INTO customer_profiles(user_id) VALUES(?)', id); q.run('INSERT INTO carts(user_id) VALUES(?)', id); }
  if (role === 'courier') q.run('INSERT INTO courier_profiles(user_id) VALUES(?)', id);
  return Number(id);
}

function seed() {
  if (q.get('SELECT COUNT(*) c FROM users').c > 0) return;
  tx(() => {
    createUser({ username: 'admin', password: 'Admin123!', role: 'admin', name: 'Admin Campus Eats' });
    const abyan = createUser({ username: 'abyan', password: 'Abyan123!', role: 'customer', name: 'Abyan', phone: '081200000001' });
    q.run('UPDATE customer_profiles SET default_floor=5, default_room=105 WHERE user_id=?', abyan);
    createUser({ username: 'agus', password: 'Agus123!', role: 'courier', name: 'Agus', phone: '081200000002' });
    createUser({ username: 'seno', password: 'Seno123!', role: 'courier', name: 'Seno', phone: '081200000003' });
    const owner = createUser({ username: 'kantinlore', password: 'Lore123!', role: 'merchant', name: 'Pemilik Kantin Lore', phone: '081200000004' });
    const mid = Number(q.run('INSERT INTO merchants(owner_id,name,description,location,open,eta_min,rating_avg,rating_count) VALUES(?,?,?,?,1,10,4.8,126)',
      owner, 'KANTIN LORE', 'Kantin pilihan mahasiswa dengan berbagai menu makanan lezat dan harga terjangkau.', 'Lantai dasar, gedung utama').lastInsertRowid);
    for (const c of ['Rice Box', 'Ayam', 'Mie', 'Minuman']) q.run('INSERT INTO categories(name) VALUES(?)', c);
    const cat = n => q.get('SELECT id FROM categories WHERE name=?', n).id;
    const prod = (name, c, price, img, desc, stock, pop, rating, sold) => Number(q.run(
      'INSERT INTO products(merchant_id,category_id,name,description,base_price,image,stock,popular,rating,sold) VALUES(?,?,?,?,?,?,?,?,?,?)',
      mid, cat(c), name, desc, price, img, stock, pop, rating, sold).lastInsertRowid);
    const V = (pid, g, label, delta, req, def, showIf, sort) => q.run(
      'INSERT INTO product_variants(product_id,group_name,label,price_delta,required,is_default,show_if,sort) VALUES(?,?,?,?,?,?,?,?)',
      pid, g, label, delta, req, def, showIf || null, sort);
    const box = prod('Rice Box Ayam Karage', 'Rice Box', 12000, 'rice', 'Nasi hangat dengan ayam karage renyah dan saus pilihan.', 30, 1, 4.9, 420);
    V(box, 'Ukuran', 'Regular', 0, 1, 1, null, 1); V(box, 'Ukuran', 'Large', 3000, 1, 0, null, 1);
    V(box, 'Tambahan', 'Tidak ada tambahan', 0, 1, 1, 'Ukuran=Large', 2);
    V(box, 'Tambahan', 'Tambah nasi', 3000, 1, 0, 'Ukuran=Large', 2); V(box, 'Tambahan', 'Tambah ayam', 5000, 1, 0, 'Ukuran=Large', 2);
    for (const s of ['Keju', 'Black Pepper', 'Barbeque', 'Lava']) V(box, 'Saus', s, 0, 1, 0, null, 3);
    const parts = ['Dada', 'Paha Atas', 'Paha Bawah', 'Sayap'];
    const sambal = ['Sambal Hijau', 'Sambal Bawang', 'Sambal Goreng', 'Sambal Terasi', 'Sambal Matah'];
    const geprek = prod('Ayam Geprek', 'Ayam', 16000, 'geprek', 'Ayam goreng crispy digeprek dengan sambal pilihanmu.', 25, 1, 4.8, 380);
    const bakar = prod('Ayam Bakar', 'Ayam', 16000, 'bakar', 'Ayam bakar bumbu kecap dengan aroma arang, disajikan dengan nasi.', 20, 0, 4.7, 210);
    for (const p of [geprek, bakar]) {
      parts.forEach(x => V(p, 'Bagian Ayam', x, 0, 1, 0, null, 1));
      sambal.forEach(x => V(p, 'Sambal', x, 0, 1, 0, null, 2));
    }
    const mie = prod('Mie Ayam', 'Mie', 16000, 'mie', 'Mie kenyal dengan topping ayam cincang dan kuah kaldu.', 25, 0, 4.7, 300);
    [['Pakai Sawi', 1], ['Pakai Ayam', 2], ['Pakai Daun Bawang', 3]].forEach(([g, s]) => {
      V(mie, g, 'Ya', 0, 1, 1, null, s); V(mie, g, 'Tidak', 0, 1, 0, null, s);
    });
    const vc = (code, d, t, v, min, pid) => q.run('INSERT INTO vouchers(code,description,type,value,min_subtotal,product_id) VALUES(?,?,?,?,?,?)', code, d, t, v, min, pid || null);
    vc('HEMAT2K', 'Diskon Rp2.000 untuk belanja minimal Rp15.000', 'fixed', 2000, 15000);
    vc('GRATISONGKIR', 'Gratis ongkir untuk belanja minimal Rp20.000', 'free_shipping', 0, 20000);
    vc('GEPREK3K', 'Diskon Rp3.000 khusus menu Ayam Geprek', 'fixed', 3000, 0, geprek);
    const st = (k, v) => q.run('INSERT INTO settings(key,value) VALUES(?,?)', k, String(v));
    [[1, 2000], [2, 2000], [3, 2000], [4, 2000], [5, 2000], [6, 2500], [7, 3000], [8, 3500], [9, 4000]].forEach(([f, v]) => st('fee_' + f, v));
    st('commission_pct', 0); st('offer_timeout_sec', 30); st('payment_timeout_sec', 300);
  });
}
seed();

module.exports = { db, q, tx, now, hashPw, verifyPw, createUser };
