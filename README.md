# CAMPUS EATS

Platform food delivery khusus kampus: pesan makanan dari kantin dan antar langsung ke **lantai & ruang kelas**.
Empat peran: **Pemesan (customer)**, **Kurir**, **Pemilik Kantin (merchant)**, dan **Admin**.

## Kebutuhan
- **Node.js 22.13 atau lebih baru** (cek: `node -v`). Unduh di https://nodejs.org
- Tidak perlu `npm install`: proyek ini **nol dependensi** (memakai `node:sqlite` bawaan Node, `crypto.scrypt` untuk hash password).
- Tanpa layanan/API berbayar. Internet hanya dipakai opsional untuk font Google dan Chart.js (CDN); tanpa internet, tampilan tetap berjalan (font sistem + grafik batang sederhana).

## Menjalankan (VS Code)
1. Buka folder `campus-eats` di VS Code.
2. Buka terminal (`Ctrl+\``), lalu jalankan:
   ```bash
   npm start
   ```
3. Buka **http://localhost:3000**.

Database otomatis dibuat di `data/campus-eats.db` beserta 5 akun demo, menu, voucher, dan tarif ongkir.
Port lain: `PORT=4000 npm start` (Windows PowerShell: `$env:PORT=4000; npm start`).
Reset data: `npm run reset-db` lalu `npm start`.
Tes otomatis alur utama: `npm test`.

## Akun demo (lihat juga `accounts.txt`)
| Peran | Username | Password |
|---|---|---|
| Admin | admin | Admin123! |
| Customer | abyan | Abyan123! |
| Kurir 1 | agus | Agus123! |
| Kurir 2 | seno | Seno123! |
| Pemilik kantin | kantinlore | Lore123! |

## Cara mencoba alur lengkap (butuh 3-4 jendela/profil browser, atau jendela incognito)
1. **Kurir** (agus/seno): masuk, aktifkan **Online** di Dashboard.
2. **Customer** (abyan): pilih menu → atur variasi → *Beli Sekarang* → **Lantai & Ruang** → bayar QRIS → *Saya Sudah Bayar*.
3. **Kurir** menerima popup "Pesanan Baru!" → *Terima Pesanan* (atau *Tolak*: ditawarkan ke kurir lain).
4. **Kantin** (kantinlore): *Pesanan* → Terima → Sedang Disiapkan → Siap Diambil.
5. **Kurir**: *Saya di Kantin* → *Makanan Sudah Diambil* → *Pesanan Selesai*.
6. Saldo masuk: kantin = harga makanan, kurir = ongkir. Customer bisa memberi rating.

Halaman otomatis diperbarui tiap beberapa detik (polling = simulasi real-time).

## Struktur folder
```
campus-eats/
├── server.js            # HTTP server + file statis
├── accounts.txt         # akun demo
├── src/
│   ├── db.js            # skema SQLite (20+ tabel), hash password, seed data
│   ├── api.js           # semua endpoint, hak akses role, logika pesanan/kurir/dompet
│   └── payment.js       # lapisan pembayaran (SIMULASI QRIS)
├── public/              # frontend (HTML + CSS + JS tanpa build)
│   ├── index.html
│   ├── css/style.css
│   └── js/core.js · customer.js · staff.js
├── tests/flow.test.js   # tes end-to-end API
└── data/                # database SQLite (dibuat otomatis)
```

## Catatan penting
- **QRIS = simulasi.** QR hanyalah gambar contoh dan tidak menerima uang sungguhan. Untuk gateway asli, ganti `createCharge()` di `src/payment.js` dan panggil `markPaid()` (di `src/api.js`) dari webhook gateway yang terverifikasi, bukan dari tombol.
- **Foto makanan:** karena aplikasi berjalan lokal tanpa aset berbayar, menu bawaan memakai ilustrasi emoji. Pemilik kantin bisa mengunggah foto asli per menu di **Menu → Edit** (disimpan di database).
- **Ikon:** SVG inline bergaya Lucide (tanpa CDN). Animasi memakai CSS.
- **Tracking:** berbasis status pesanan (bukan GPS).
- Stok dikurangi saat checkout (reservasi), dikembalikan bila pembayaran dibatalkan/kedaluwarsa (5 menit) atau pesanan dibatalkan/ditolak. Pesanan offline memakai stok yang sama.
- Pembatalan oleh pembeli diizinkan sampai kantin mulai menyiapkan makanan; pesanan berbayar dikembalikan ke **saldo refund**.
- Hapus akun kurir/kantin oleh admin bersifat *soft delete* agar riwayat transaksi tetap utuh. Akun pembeli cukup dinonaktifkan.
- Komisi platform default 0% (bisa diubah admin di Pengaturan, begitu juga ongkir per lantai & batas waktu).

## Keamanan
Password di-hash (scrypt + salt), sesi memakai cookie HttpOnly, semua endpoint divalidasi di backend berdasarkan role dan kepemilikan data, harga/ongkir/voucher dihitung ulang di server, pembatasan percobaan login.
