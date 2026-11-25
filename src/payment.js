const { AppError } = require('./errors');

const ORDER_STAGE = Object.freeze({
  MENUNGGU: 'menunggu',
  DIPROSES: 'diproses',
  SIAP_DIAMBIL: 'siap_diambil',
  SELESAI: 'selesai',
  DIBATALKAN: 'dibatalkan',
});

const ORDER_STAGE_TRANSITIONS = Object.freeze({
  [ORDER_STAGE.MENUNGGU]: [ORDER_STAGE.DIPROSES, ORDER_STAGE.DIBATALKAN],
  [ORDER_STAGE.DIPROSES]: [ORDER_STAGE.SIAP_DIAMBIL, ORDER_STAGE.DIBATALKAN],
  [ORDER_STAGE.SIAP_DIAMBIL]: [ORDER_STAGE.SELESAI, ORDER_STAGE.DIBATALKAN],
  [ORDER_STAGE.SELESAI]: [],
  [ORDER_STAGE.DIBATALKAN]: [],
});

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
});

const PAYMENT_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.PENDING]: [
    PAYMENT_STATUS.PAID,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.EXPIRED,
    PAYMENT_STATUS.CANCELLED,
  ],
  [PAYMENT_STATUS.PAID]: [PAYMENT_STATUS.REFUNDED],
  [PAYMENT_STATUS.FAILED]: [],
  [PAYMENT_STATUS.EXPIRED]: [],
  [PAYMENT_STATUS.CANCELLED]: [],
  [PAYMENT_STATUS.REFUNDED]: [],
});

function deriveOrderStage(status) {
  switch (status) {
    case 'MENUNGGU_PEMBAYARAN':
      return ORDER_STAGE.MENUNGGU;
    case 'PEMBAYARAN_BERHASIL':
    case 'MENCARI_KURIR':
    case 'KURIR_DITEMUKAN':
    case 'MENUNGGU_DISIAPKAN':
    case 'SEDANG_DISIAPKAN':
      return ORDER_STAGE.DIPROSES;
    case 'SIAP_DIAMBIL':
    case 'KURIR_MENGAMBIL':
    case 'DALAM_PENGANTARAN':
      return ORDER_STAGE.SIAP_DIAMBIL;
    case 'SELESAI':
      return ORDER_STAGE.SELESAI;
    case 'DIBATALKAN':
      return ORDER_STAGE.DIBATALKAN;
    default:
      return ORDER_STAGE.MENUNGGU;
  }
}

function canTransitionOrderStage(fromStage, toStage) {
  if (fromStage === toStage) return true;
  const allowed = ORDER_STAGE_TRANSITIONS[fromStage] || [];
  return allowed.includes(toStage);
}

function assertOrderStageTransition(fromStage, toStage) {
  if (!canTransitionOrderStage(fromStage, toStage)) {
    throw new AppError(
      409,
      'INVALID_ORDER_TRANSITION',
      `Transisi status pesanan dari '${fromStage}' ke '${toStage}' tidak diizinkan`
    );
  }
}

function normalizePaymentStatus(status) {
  return String(status || '').toLowerCase();
}

function canTransitionPayment(fromStatus, toStatus) {
  const from = normalizePaymentStatus(fromStatus);
  const to = normalizePaymentStatus(toStatus);
  const allowed = PAYMENT_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function assertPaymentTransition(fromStatus, toStatus) {
  if (!canTransitionPayment(fromStatus, toStatus)) {
    throw new AppError(
      409,
      'INVALID_PAYMENT_TRANSITION',
      `Transisi status pembayaran dari '${fromStatus}' ke '${toStatus}' tidak diizinkan`
    );
  }
}

module.exports = {
  provider: 'SIMULASI',
  ORDER_STAGE,
  ORDER_STAGE_TRANSITIONS,
  PAYMENT_STATUS,
  PAYMENT_TRANSITIONS,
  deriveOrderStage,
  canTransitionOrderStage,
  assertOrderStageTransition,
  normalizePaymentStatus,
  canTransitionPayment,
  assertPaymentTransition,
  createCharge(order) {
    return {
      provider: 'SIMULASI',
      method: 'QRIS',
      ref: 'SIM-' + order.code,
      payload: `CAMPUSEATS|${order.code}|${order.total}`,
      status: PAYMENT_STATUS.PENDING,
      expires_at: order.expiresAt || null,
    };
  },
};
