# Panduan Deployment Campus Eats (Gratis / Rp0)

Panduan ini disusun langkah demi langkah untuk pemula agar **Campus Eats** bisa berjalan online secara gratis menggunakan **Turso (database cloud)** dan **Render (hosting Node.js)**.

---

## Mengapa Render + Turso? (dan Catatan Keterbatasan Free Tier)

- **Database — Turso (libSQL, Free Tier):** gratis tanpa kartu kredit, memakai dialek SQLite yang sama dengan kode lokal, persisten, dan tidak *auto-pause* yang menghapus data.
- **Hosting — Render (Web Service, Free Tier):** cocok untuk server Express persisten (beserta job berkala seperti timeout pembayaran dan penawaran kurir).
  - ⚠️ **Keterbatasan Render Free:** server akan masuk mode tidur (*sleep*) setelah **±15 menit tidak ada aktivitas**. Saat ada pengunjung baru setelah tidur, request pertama membutuhkan waktu **20–50 detik** (*cold start*) sampai server bangun kembali.
- **Mengapa tidak Vercel?** Vercel memakai arsitektur *serverless* (fungsi berjalan sesaat lalu mati), sehingga server Express persisten dan interval latar belakang tidak berjalan normal tanpa refaktor besar.
- **Bagaimana dengan Railway?** Railway hanya menyediakan masa trial/kredit terbatas (bukan gratis permanen), sehingga cocok hanya sebagai alternatif berbayar jika nanti ingin tanpa *cold start*.

---

## Langkah 1: Membuat Database Cloud Gratis di Turso

1. Buka [https://turso.tech](https://turso.tech) lalu daftar / masuk (bisa memakai akun GitHub, tanpa kartu kredit).
2. Di dashboard Turso, klik **Create Database**.
   - Isi nama database, misalnya `campus-eats`.
   - Pilih lokasi region terdekat (misalnya **Singapore / ap-southeast-1** atau Tokyo).
   - Klik **Create**.
3. Setelah database dibuat, ambil dua informasi penting:
   - **Database URL** (formatnya seperti `libsql://campus-eats-namakamu.turso.io`) → ini akan menjadi nilai `DATABASE_URL`.
   - Klik **Create Token** (pilih akses **Read & Write** dan masa berlaku **No Expiration** atau sesuai kebutuhan), lalu salin token panjang yang muncul → ini akan menjadi nilai `DATABASE_AUTH_TOKEN`.
4. Simpan kedua nilai ini sementara di catatan pribadi yang aman (jangan taruh di GitHub!).

---

## Langkah 2: Membuat `JWT_SECRET` yang Kuat

`JWT_SECRET` dipakai untuk menandatangani token login agar tidak bisa dipalsukan. Jangan pakai kata-kata pendek atau mudah ditebak.

Jalankan salah satu perintah berikut di terminal komputermu untuk membuat string acak yang aman:

**Menggunakan Node.js (Windows PowerShell / Command Prompt / Mac / Linux):**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**Atau menggunakan OpenSSL (Mac / Linux / Git Bash):**
```bash
openssl rand -hex 48
```

Salin hasil string acak panjang tersebut untuk diisi ke Environment Variable `JWT_SECRET` di Render.

---

## Langkah 3: Push Proyek ke GitHub

1. Buat repository baru di [https://github.com/new](https://github.com/new) (boleh **Public** maupun **Private**). Jangan centang "Add a README" karena repo lokal sudah punya file.
2. Pastikan file `.env`, folder `data/*.db`, dan `accounts.txt` **tidak ikut ter-commit** (sudah otomatis diabaikan oleh `.gitignore`).
3. Jalankan perintah berikut di terminal folder proyek `campus-eats` (ganti URL dengan URL repo GitHub kamu):
   ```bash
   git checkout stage-3-deploy
   git remote add origin https://github.com/USERNAME/campus-eats.git
   git push -u origin stage-3-deploy
   ```
   *(Jika ingin deploy dari branch `main`, merge dulu `stage-3-deploy` ke `main` lalu push `main`.)*

---

## Langkah 4: Deploy ke Render (Gratis)

1. Daftar / masuk ke [https://dashboard.render.com](https://dashboard.render.com) menggunakan akun GitHub.
2. Klik tombol **New +** → pilih **Web Service** (atau pilih **Blueprint** jika ingin Render membaca file `render.yaml` secara otomatis).
3. Hubungkan repository GitHub `campus-eats` kamu.
4. Jika membuat **Web Service** manual, isi konfigurasi berikut:
   - **Branch:** `stage-3-deploy` (atau `main` jika sudah di-merge)
   - **Runtime:** `Node`
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
   - **Health Check Path:** `/health`
5. Buka bagian **Environment Variables** dan tambahkan variabel berikut satu per satu:

| Key | Value (Contoh / Cara Mengisi) |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `libsql://campus-eats-...turso.io` (dari Langkah 1) |
| `DATABASE_AUTH_TOKEN` | Token Turso dari Langkah 1 |
| `JWT_SECRET` | String acak 96 karakter dari Langkah 2 |
| `CORS_ORIGIN` | URL aplikasi Render kamu nanti, mis. `https://campus-eats.onrender.com` (kosongkan dulu atau isi setelah dapat URL, lalu redeploy) |
| `SEED_ADMIN_PASSWORD` | Password kuat pilihanmu sendiri untuk akun `admin` |
| `SEED_CUSTOMER_PASSWORD` | Password kuat pilihanmu sendiri untuk akun `abyan` |
| `SEED_COURIER_PASSWORD` | Password kuat pilihanmu sendiri untuk akun `agus` & `seno` |
| `SEED_MERCHANT_PASSWORD` | Password kuat pilihanmu sendiri untuk akun `kantinlore` |

6. Klik **Create Web Service**.
7. Pantau tab **Logs** di Render:
   - Render akan menjalankan `npm ci`, lalu `npm start`.
   - Saat pertama kali start, aplikasi otomatis membuat tabel di Turso (migrasi) dan mengisi data awal (seeder).
   - Tunggu sampai muncul log: `Campus Eats berjalan di http://0.0.0.0:10000` dan status berubah menjadi **Live**.

---

## Langkah 5: Daftar Akun Demo (Setelah Seeding Berjalan)

Seeder hanya berjalan satu kali saat tabel `users` masih kosong. Password untuk akun di bawah ini mengikuti nilai `SEED_*_PASSWORD` yang kamu masukkan di Environment Variables Render (tidak pernah disimpan di repo publik):

| Peran | Username | Diatur Oleh Env Variable |
|---|---|---|
| Admin | `admin` | `SEED_ADMIN_PASSWORD` |
| Pemesan (Customer) | `abyan` | `SEED_CUSTOMER_PASSWORD` |
| Kurir 1 | `agus` | `SEED_COURIER_PASSWORD` |
| Kurir 2 | `seno` | `SEED_COURIER_PASSWORD` |
| Pemilik Kantin (Merchant) | `kantinlore` | `SEED_MERCHANT_PASSWORD` |

---

## Langkah 6: Checklist Verifikasi Setelah Live

Buka URL aplikasi Render kamu (misalnya `https://campus-eats.onrender.com`) dan uji poin berikut:

- [ ] **Health check:** buka `/health`, pastikan muncul JSON `{ "status": "ok", "db": "connected", ... }`.
- [ ] **Login Pemilik Kantin (`kantinlore`) & Admin (`admin`):** pastikan berhasil masuk, dashboard tampil, dan halaman tidak kembali logout setelah di-refresh (`F5`).
- [ ] **Login Kurir (`agus`) & aktifkan Online:** di jendela browser lain (atau mode Incognito), login sebagai `agus` dan nyalakan toggle **Online**.
- [ ] **Buat Pesanan & Bayar (Customer `abyan` atau daftar akun baru):**
  - Pilih menu (mis. Ayam Geprek), atur variasi, masukkan keranjang, pilih lantai & ruang, lalu klik **Bayar dengan QRIS**.
  - Klik **Saya Sudah Bayar** (simulasi).
- [ ] **Proses Pesanan:**
  - Pastikan kurir (`agus`) mendapat tawaran dan bisa menerima.
  - Pastikan kantin (`kantinlore`) melihat status pembayaran `paid` dan bisa klik **Terima → Sedang Disiapkan → Siap Diambil**.
  - Pastikan kurir menyelesaikan pengantaran sampai status menjadi **Pesanan Selesai** dan saldo wallet bertambah.

---

## Troubleshooting Umum

1. **Halaman loading sangat lama saat baru dibuka (>30 detik):**
   - Ini normal pada **Render Free Tier** (*cold start*) jika aplikasi tidak diakses selama >15 menit. Tunggu sekitar 30–50 detik lalu muat ulang halaman.
2. **Deploy gagal atau `/health` mengembalikan `503 db: disconnected`:**
   - Cek ulang `DATABASE_URL` dan `DATABASE_AUTH_TOKEN` di tab **Environment** Render. Pastikan tidak ada spasi berlebih dan token Turso memiliki izin **Read & Write**.
3. **Server gagal start dengan error `JWT_SECRET wajib diisi`:**
   - Pastikan `JWT_SECRET` sudah diisi di Environment Variables Render minimal 32 karakter.
4. **Error CORS saat mengakses API:**
   - Pastikan `CORS_ORIGIN` berisi URL persis aplikasi Render kamu (termasuk `https://`, tanpa garis miring `/` di akhir). Jika frontend dan backend berada di satu domain Render yang sama, kamu juga boleh mengosongkan `CORS_ORIGIN`.
5. **Login berhasil tetapi langsung ter-logout setelah refresh:**
   - Pastikan mengakses lewat **`https://`** (bukan `http://`) karena di mode `production`, cookie `ce_sid` menggunakan flag `Secure; HttpOnly; SameSite=Lax`.
6. **Akun demo tidak bisa login:**
   - Pastikan keempat variabel `SEED_*_PASSWORD` sudah diisi **sebelum** server pertama kali menyala ke database kosong. Jika sebelumnya sempat menyala sebelum `SEED_*` diisi, tabel `users` masih kosong—cukup isi variabel `SEED_*_PASSWORD` di Render lalu klik **Manual Deploy → Deploy latest commit**.
