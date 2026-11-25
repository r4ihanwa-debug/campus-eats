// Lapisan pembayaran. Versi demo = SIMULASI QRIS (tidak menerima uang sungguhan).
// Untuk integrasi payment gateway QRIS sungguhan: ganti isi createCharge() agar memanggil
// API gateway, lalu verifikasi webhook gateway dan panggil markPaid() di src/api.js
// setelah pembayaran terverifikasi.
module.exports = {
  provider: 'SIMULASI',
  createCharge(order) {
    return { ref: 'SIM-' + order.code, payload: `CAMPUSEATS|${order.code}|${order.total}` };
  },
};
