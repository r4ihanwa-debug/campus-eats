# CAMPUS EATS

Platform food delivery khusus kampus: pesan makanan dari kantin dan antar langsung ke **lantai & ruang kelas**.
Empat peran: **Pemesan (`customer`)**, **Kurir (`courier`)**, **Pemilik Kantin (`merchant`)**, dan **Admin (`admin`)**.

## Teknologi
- **Runtime:** Node.js >= 22.13.0 (`express`, `helmet`, `cors`, `express-rate-limit`, `jsonwebtoken`, `bcryptjs`, `zod`)
- **Database:** **Turso (libSQL)** untuk production (`DATABASE_URL` + `DATABASE_AUTH_TOKEN`), dengan fallback otomatis ke **SQLite lokal** (`data/campus-eats.db`) saat development.
- **Deployment:** Siap deploy gratis (Rp0) ke **Render** — lihat panduan lengkap di [DEPLOY.md](./DEPLOY.md).

## Menjalankan Secara Lokal
1. Salin `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
2. Isi variabel `SEED_*_PASSWORD` di `.env` dengan password pilihanmu sendiri (dan `JWT_SECRET` untuk production).
3. Instal dependensi dan jalankan:
   ```bash
   npm install
   npm start
   ```
4. Buka **http://localhost:3000** (cek kesehatan server di `/health`).

Tes otomatis end-to-end (menggunakan database sementara terpisah):
```bash
npm test
```

## Akun Demo (Seeder Idempoten)
Saat database masih kosong, seeder membuat 5 akun awal dengan password dari environment variable `SEED_*_PASSWORD`:

| Peran | Username | Environment Variable |
|---|---|---|
| Admin | `admin` | `SEED_ADMIN_PASSWORD` |
| Customer | `abyan` | `SEED_CUSTOMER_PASSWORD` |
| Kurir 1 | `agus` | `SEED_COURIER_PASSWORD` |
| Kurir 2 | `seno` | `SEED_COURIER_PASSWORD` |
| Pemilik kantin | `kantinlore` | `SEED_MERCHANT_PASSWORD` |

## Struktur Folder
```text
campus-eats/
├── server.js                  # Express app, security headers, CORS, /health, static files
├── render.yaml                # Konfigurasi Blueprint Render
├── DEPLOY.md                  # Panduan deployment pemula (Turso + Render)
├── .env.example               # Template environment variables
├── migrations/
│   ├── 001_init.sql           # Skema awal (23 tabel + indeks)
│   └── 002_payment_and_stage.sql
├── src/
│   ├── db.js                  # Koneksi Turso/libSQL, migrasi otomatis, seeder bcrypt
│   ├── auth.js                # JWT (HttpOnly cookie + Bearer), requireAuth, requireRole
│   ├── errors.js              # Format error JSON seragam & global error handler
│   ├── validators.js          # Skema validasi input (Zod)
│   ├── payment.js             # State machine pesanan & pembayaran (simulasi QRIS)
│   └── api.js                 # Router endpoint API
├── public/                    # Frontend Vanilla JS (HTML + CSS + JS)
└── tests/flow.test.js         # Tes end-to-end API
```
