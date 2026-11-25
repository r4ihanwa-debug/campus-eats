const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

try {
  require('dotenv').config({ quiet: true });
} catch {
  // Ignore if dotenv is not needed in certain environments
}

const txStorage = new AsyncLocalStorage();
let client = null;
let isRemote = false;
let initPromise = null;
let writeQueue = Promise.resolve();

function resolveDbConfig() {
  const remoteUrl = (process.env.DATABASE_URL || '').trim();
  if (remoteUrl) {
    const authToken = (process.env.DATABASE_AUTH_TOKEN || '').trim() || undefined;
    const remote = !remoteUrl.startsWith('file:') && remoteUrl !== ':memory:';
    return { url: remoteUrl, authToken, remote };
  }

  const dbFile = (process.env.DB_FILE || '').trim();
  if (dbFile === ':memory:') {
    return { url: ':memory:', authToken: undefined, remote: false };
  }

  const resolved = dbFile
    ? path.resolve(dbFile)
    : path.join(__dirname, '..', 'data', 'campus-eats.db');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return {
    url: 'file:' + resolved.replace(/\\/g, '/'),
    authToken: undefined,
    remote: false,
  };
}

function getClient() {
  if (!client) {
    const cfg = resolveDbConfig();
    isRemote = cfg.remote;
    client = createClient({
      url: cfg.url,
      ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
    });
  }
  return client;
}

function sanitizeArgs(args) {
  return args.map(a => (a === undefined ? null : a));
}

async function exec(sql, args = []) {
  const runner = txStorage.getStore() || getClient();
  return runner.execute({ sql, args: sanitizeArgs(args) });
}

const q = {
  async get(sql, ...args) {
    const res = await exec(sql, args);
    return res.rows[0] ? { ...res.rows[0] } : undefined;
  },
  async all(sql, ...args) {
    const res = await exec(sql, args);
    return res.rows.map(r => ({ ...r }));
  },
  async run(sql, ...args) {
    const res = await exec(sql, args);
    return {
      changes: res.rowsAffected ?? 0,
      lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
    };
  },
};

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

async function tx(fn) {
  const activeTx = txStorage.getStore();
  if (activeTx) {
    return fn(activeTx);
  }
  return withWriteLock(async () => {
    const t = await getClient().transaction('write');
    try {
      const result = await txStorage.run(t, () => fn(t));
      await t.commit();
      return result;
    } catch (err) {
      try {
        await t.rollback();
      } catch {
        // Ignore rollback errors if transaction was already closed
      }
      throw err;
    } finally {
      t.close();
    }
  });
}

const now = () => Date.now();

async function hashPw(pw) {
  return bcrypt.hash(String(pw), 10);
}

async function verifyPw(pw, stored) {
  const raw = String(stored || '');
  if (raw.startsWith('$2a$') || raw.startsWith('$2b$') || raw.startsWith('$2y$')) {
    return bcrypt.compare(String(pw), raw);
  }
  const [salt, h] = raw.split(':');
  if (!salt || !h) return false;
  const t = crypto.scryptSync(String(pw), salt, 64);
  const b = Buffer.from(h, 'hex');
  return b.length === t.length && crypto.timingSafeEqual(b, t);
}

async function createUser({ username, password, role, name, phone }) {
  const passwordHash = await hashPw(password);
  const res = await q.run(
    'INSERT INTO users(username,password_hash,role,name,phone,created_at) VALUES(?,?,?,?,?,?)',
    username,
    passwordHash,
    role,
    name,
    phone || null,
    now()
  );
  const id = Number(res.lastInsertRowid);
  await q.run('INSERT INTO wallets(user_id) VALUES(?)', id);
  if (role === 'customer') {
    await q.run('INSERT INTO customer_profiles(user_id) VALUES(?)', id);
    await q.run('INSERT INTO carts(user_id) VALUES(?)', id);
  }
  if (role === 'courier') {
    await q.run('INSERT INTO courier_profiles(user_id) VALUES(?)', id);
  }
  return id;
}

async function runMigrations() {
  const c = getClient();
  if (!isRemote) {
    await c.execute('PRAGMA foreign_keys = ON');
    await c.execute('PRAGMA busy_timeout = 5000');
  }
  await c.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );

  const migDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migDir)) return;
  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const exists = await q.get('SELECT 1 AS ok FROM schema_migrations WHERE id = ?', file);
    if (exists) continue;
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    await c.executeMultiple(sql);
    await q.run('INSERT INTO schema_migrations(id, applied_at) VALUES(?, ?)', file, now());
  }
}

async function seedBaseSettingsAndCategories() {
  const feeDefaults = [
    [1, 2000], [2, 2000], [3, 2000], [4, 2000], [5, 2000],
    [6, 2500], [7, 3000], [8, 3500], [9, 4000],
  ];
  for (const [f, v] of feeDefaults) {
    await q.run('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', 'fee_' + f, String(v));
  }
  await q.run("INSERT OR IGNORE INTO settings(key, value) VALUES('commission_pct', '0')");
  await q.run("INSERT OR IGNORE INTO settings(key, value) VALUES('offer_timeout_sec', '30')");
  await q.run("INSERT OR IGNORE INTO settings(key, value) VALUES('payment_timeout_sec', '300')");

  for (const c of ['Rice Box', 'Ayam', 'Mie', 'Minuman']) {
    await q.run('INSERT OR IGNORE INTO categories(name) VALUES(?)', c);
  }
}

async function seed() {
  await seedBaseSettingsAndCategories();

  const existing = await q.get('SELECT COUNT(*) AS c FROM users');
  if (Number(existing.c) > 0) return { seeded: false };

  const adminPw = process.env.SEED_ADMIN_PASSWORD;
  const customerPw = process.env.SEED_CUSTOMER_PASSWORD;
  const courierPw = process.env.SEED_COURIER_PASSWORD;
  const merchantPw = process.env.SEED_MERCHANT_PASSWORD;

  if (!adminPw || !customerPw || !courierPw || !merchantPw) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[seed] Tabel users kosong, tetapi SEED_ADMIN_PASSWORD / SEED_CUSTOMER_PASSWORD / SEED_COURIER_PASSWORD / SEED_MERCHANT_PASSWORD belum lengkap. Seeding akun demo dilewati.'
      );
    }
    return { seeded: false };
  }

  await tx(async () => {
    const doubleCheck = await q.get('SELECT COUNT(*) AS c FROM users');
    if (Number(doubleCheck.c) > 0) return;

    await createUser({ username: 'admin', password: adminPw, role: 'admin', name: 'Admin Campus Eats' });
    const abyan = await createUser({
      username: 'abyan',
      password: customerPw,
      role: 'customer',
      name: 'Abyan',
      phone: '081200000001',
    });
    await q.run('UPDATE customer_profiles SET default_floor=5, default_room=105 WHERE user_id=?', abyan);
    await createUser({
      username: 'agus',
      password: courierPw,
      role: 'courier',
      name: 'Agus',
      phone: '081200000002',
    });
    await createUser({
      username: 'seno',
      password: courierPw,
      role: 'courier',
      name: 'Seno',
      phone: '081200000003',
    });
    const owner = await createUser({
      username: 'kantinlore',
      password: merchantPw,
      role: 'merchant',
      name: 'Pemilik Kantin Lore',
      phone: '081200000004',
    });

    const mRes = await q.run(
      'INSERT INTO merchants(owner_id,name,description,location,open,eta_min,rating_avg,rating_count) VALUES(?,?,?,?,1,10,4.8,126)',
      owner,
      'KANTIN LORE',
      'Kantin pilihan mahasiswa dengan berbagai menu makanan lezat dan harga terjangkau.',
      'Lantai dasar, gedung utama'
    );
    const mid = Number(mRes.lastInsertRowid);

    const cat = async n => (await q.get('SELECT id FROM categories WHERE name=?', n)).id;
    const prod = async (name, c, price, img, desc, stock, pop, rating, sold) => {
      const catId = await cat(c);
      const r = await q.run(
        'INSERT INTO products(merchant_id,category_id,name,description,base_price,image,stock,popular,rating,sold) VALUES(?,?,?,?,?,?,?,?,?,?)',
        mid, catId, name, desc, price, img, stock, pop, rating, sold
      );
      return Number(r.lastInsertRowid);
    };
    const V = (pid, g, label, delta, req, def, showIf, sort) =>
      q.run(
        'INSERT INTO product_variants(product_id,group_name,label,price_delta,required,is_default,show_if,sort) VALUES(?,?,?,?,?,?,?,?)',
        pid, g, label, delta, req, def, showIf || null, sort
      );

    const box = await prod(
      'Rice Box Ayam Karage',
      'Rice Box',
      12000,
      'rice',
      'Nasi hangat dengan ayam karage renyah dan saus pilihan.',
      30,
      1,
      4.9,
      420
    );
    await V(box, 'Ukuran', 'Regular', 0, 1, 1, null, 1);
    await V(box, 'Ukuran', 'Large', 3000, 1, 0, null, 1);
    await V(box, 'Tambahan', 'Tidak ada tambahan', 0, 1, 1, 'Ukuran=Large', 2);
    await V(box, 'Tambahan', 'Tambah nasi', 3000, 1, 0, 'Ukuran=Large', 2);
    await V(box, 'Tambahan', 'Tambah ayam', 5000, 1, 0, 'Ukuran=Large', 2);
    for (const s of ['Keju', 'Black Pepper', 'Barbeque', 'Lava']) {
      await V(box, 'Saus', s, 0, 1, 0, null, 3);
    }

    const parts = ['Dada', 'Paha Atas', 'Paha Bawah', 'Sayap'];
    const sambal = ['Sambal Hijau', 'Sambal Bawang', 'Sambal Goreng', 'Sambal Terasi', 'Sambal Matah'];
    const geprek = await prod(
      'Ayam Geprek',
      'Ayam',
      16000,
      'geprek',
      'Ayam goreng crispy digeprek dengan sambal pilihanmu.',
      25,
      1,
      4.8,
      380
    );
    const bakar = await prod(
      'Ayam Bakar',
      'Ayam',
      16000,
      'bakar',
      'Ayam bakar bumbu kecap dengan aroma arang, disajikan dengan nasi.',
      20,
      0,
      4.7,
      210
    );
    for (const p of [geprek, bakar]) {
      for (const x of parts) await V(p, 'Bagian Ayam', x, 0, 1, 0, null, 1);
      for (const x of sambal) await V(p, 'Sambal', x, 0, 1, 0, null, 2);
    }

    const mie = await prod(
      'Mie Ayam',
      'Mie',
      16000,
      'mie',
      'Mie kenyal dengan topping ayam cincang dan kuah kaldu.',
      25,
      0,
      4.7,
      300
    );
    for (const [g, s] of [['Pakai Sawi', 1], ['Pakai Ayam', 2], ['Pakai Daun Bawang', 3]]) {
      await V(mie, g, 'Ya', 0, 1, 1, null, s);
      await V(mie, g, 'Tidak', 0, 1, 0, null, s);
    }

    const vc = (code, d, t, v, min, pid) =>
      q.run(
        'INSERT OR IGNORE INTO vouchers(code,description,type,value,min_subtotal,product_id) VALUES(?,?,?,?,?,?)',
        code, d, t, v, min, pid || null
      );
    await vc('HEMAT2K', 'Diskon Rp2.000 untuk belanja minimal Rp15.000', 'fixed', 2000, 15000);
    await vc('GRATISONGKIR', 'Gratis ongkir untuk belanja minimal Rp20.000', 'free_shipping', 0, 20000);
    await vc('GEPREK3K', 'Diskon Rp3.000 khusus menu Ayam Geprek', 'fixed', 3000, 0, geprek);
  });

  return { seeded: true };
}

async function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await runMigrations();
      await seed();
    })().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function pingDb() {
  await q.get('SELECT 1 AS ok');
}

async function closeDb() {
  if (client) {
    client.close();
    client = null;
    initPromise = null;
  }
}

module.exports = {
  getClient,
  q,
  tx,
  now,
  hashPw,
  verifyPw,
  createUser,
  initDb,
  pingDb,
  closeDb,
};
