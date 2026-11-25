const { z } = require('zod');
const { AppError } = require('./errors');

const idParamSchema = z.coerce.number().int().positive();

function parseId(raw, label = 'ID') {
  const res = idParamSchema.safeParse(raw);
  if (!res.success) {
    throw new AppError(400, 'VALIDATION_ERROR', `${label} harus berupa angka bulat positif`, {
      id: `${label} tidak valid`,
    });
  }
  return res.data;
}

function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return next(parsed.error);
    req.body = parsed.data;
    next();
  };
}

const optPhone = z.preprocess(
  v => (v === '' || v === undefined || v === null ? null : String(v).trim()),
  z.string().min(8, 'No. HP minimal 8 digit').max(16, 'No. HP maksimal 16 digit').regex(/^[0-9+]+$/, 'No. HP hanya boleh berisi angka').nullable()
);

const loginSchema = z.object({
  username: z.string({ required_error: 'Username wajib diisi' }).trim().min(1, 'Username wajib diisi').max(50, 'Username terlalu panjang'),
  password: z.string({ required_error: 'Password wajib diisi' }).min(1, 'Password wajib diisi').max(72, 'Password terlalu panjang'),
});

const registerSchema = z.object({
  role: z.enum(['customer', 'courier', 'merchant'], { message: 'Jenis akun tidak valid' }),
  username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,20}$/, 'Username 3-20 karakter (huruf, angka, underscore)'),
  password: z.string().min(6, 'Password minimal 6 karakter').max(72, 'Password maksimal 72 karakter'),
  name: z.string().trim().min(2, 'Nama harus 2-60 karakter').max(60, 'Nama harus 2-60 karakter'),
  phone: optPhone.optional(),
  store_name: z.string().trim().min(3, 'Nama kantin harus 3-50 karakter').max(50, 'Nama kantin harus 3-50 karakter').optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Nama harus 2-60 karakter').max(60, 'Nama harus 2-60 karakter'),
  phone: optPhone.optional(),
  default_floor: z.preprocess(v => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().min(1).max(9).nullable().optional()),
  default_room: z.preprocess(v => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().min(101).max(120).nullable().optional()),
});

const passwordChangeSchema = z.object({
  current: z.string().min(1, 'Password lama wajib diisi').max(72),
  next: z.string().min(6, 'Password baru minimal 6 karakter').max(72, 'Password baru maksimal 72 karakter'),
});

const complaintSchema = z.object({
  order_id: z.preprocess(v => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().positive().nullable().optional()),
  subject: z.string().trim().min(3, 'Judul harus 3-80 karakter').max(80, 'Judul harus 3-80 karakter'),
  message: z.string().trim().min(5, 'Pesan harus 5-1000 karakter').max(1000, 'Pesan harus 5-1000 karakter'),
});

const cartAddSchema = z.object({
  product_id: z.coerce.number().int().positive('Menu tidak valid'),
  qty: z.coerce.number().int().min(1, 'Jumlah minimal 1').max(20, 'Jumlah maksimal 20').default(1),
  options: z.record(z.string(), z.string()).optional().default({}),
  note: z.preprocess(v => (v === null || v === undefined ? '' : String(v)), z.string().max(200)).optional(),
});

const cartPatchSchema = z.object({
  qty: z.coerce.number().int().min(1, 'Jumlah minimal 1').max(20, 'Jumlah maksimal 20').optional(),
  options: z.record(z.string(), z.string()).optional(),
  note: z.preprocess(v => (v === undefined ? undefined : v === null ? '' : String(v)), z.string().max(200).optional()),
});

const voucherCheckSchema = z.object({
  code: z.string().trim().min(1, 'Kode voucher wajib diisi').max(20),
  floor: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().int().min(1).max(9).optional()),
});

const orderCreateSchema = z.object({
  floor: z.coerce.number().int('Lantai tidak valid').min(1, 'Lantai harus 1-9').max(9, 'Lantai harus 1-9'),
  room: z.coerce.number().int('Ruang tidak valid').min(101, 'Ruang harus 101-120').max(120, 'Ruang harus 101-120'),
  recipient: z.string({ required_error: 'Nama penerima wajib diisi' }).trim().min(2, 'Nama penerima harus 2-60 karakter').max(60, 'Nama penerima harus 2-60 karakter'),
  courier_note: z.preprocess(v => (v === null || v === undefined ? '' : String(v)), z.string().max(200)).optional(),
  voucher: z.preprocess(v => (v === null || v === undefined ? '' : String(v).trim()), z.string().max(20)).optional(),
});

const orderCancelSchema = z.object({
  reason: z.preprocess(v => (v === null || v === undefined ? '' : String(v).trim()), z.string().max(120)).optional(),
});

const rateSchema = z.object({
  merchant_stars: z.coerce.number().int().min(1, 'Rating kantin 1-5').max(5, 'Rating kantin 1-5'),
  courier_stars: z.coerce.number().int().min(1, 'Rating kurir 1-5').max(5, 'Rating kurir 1-5'),
  review: z.preprocess(v => (v === null || v === undefined ? '' : String(v)), z.string().max(300)).optional(),
});

const storeSchema = z.object({
  name: z.string().trim().min(3, 'Nama kantin 3-50 karakter').max(50),
  description: z.preprocess(v => String(v ?? '').trim(), z.string().max(300)),
  location: z.preprocess(v => String(v ?? '').trim(), z.string().max(100)),
  open: z.boolean().or(z.number().int().min(0).max(1)),
  eta_min: z.coerce.number().int().min(3, 'Estimasi 3-60 menit').max(60, 'Estimasi 3-60 menit'),
});

const variantSchema = z.object({
  group_name: z.string().trim().min(1, 'Nama grup variasi wajib diisi').max(40),
  label: z.string().trim().min(1, 'Nama pilihan wajib diisi').max(40),
  price_delta: z.coerce.number().int().min(-100000).max(100000).default(0),
  required: z.any().transform(Boolean).default(true),
  is_default: z.any().transform(Boolean).default(false),
  show_if: z.preprocess(v => (v === '' || v === null || v === undefined ? null : String(v).trim()), z.string().min(3).max(90).nullable().optional()),
});

const productSchema = z.object({
  name: z.string().trim().min(2, 'Nama menu 2-60 karakter').max(60),
  description: z.preprocess(v => String(v ?? '').trim(), z.string().max(300)),
  base_price: z.coerce.number().int('Harga harus bilangan bulat').min(500, 'Harga minimal Rp500').max(1000000, 'Harga maksimal Rp1.000.000'),
  stock: z.coerce.number().int('Stok harus bilangan bulat').min(0, 'Stok minimal 0').max(9999, 'Stok maksimal 9999'),
  active: z.any().transform(Boolean).default(true),
  popular: z.any().transform(Boolean).default(false),
  image: z.preprocess(v => String(v || 'default'), z.string()),
  category: z.preprocess(v => String(v || 'Lainnya').trim(), z.string().min(2).max(30)),
  variants: z.array(variantSchema).max(60, 'Terlalu banyak variasi').default([]),
});

const stockPatchSchema = z.object({
  stock: z.coerce.number().int('Stok harus bilangan bulat').min(0, 'Stok minimal 0').max(9999, 'Stok maksimal 9999'),
});

const activePatchSchema = z.object({
  active: z.boolean({ required_error: 'Status active harus boolean' }),
});

const rejectOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Alasan penolakan 3-120 karakter').max(120),
});

const offlineOrderSchema = z.object({
  items: z.array(z.object({
    product_id: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().min(1).max(50),
    options: z.record(z.string(), z.string()).optional(),
  })).min(1, 'Pilih minimal satu menu'),
  note: z.preprocess(v => (v === null || v === undefined ? '' : String(v)), z.string().max(60)).optional(),
});

const adminSettingsSchema = z.object({
  fees: z.record(z.string(), z.coerce.number().int().min(0).max(50000)),
  commission_pct: z.coerce.number().int().min(0).max(50),
  offer_timeout_sec: z.coerce.number().int().min(10).max(120),
  payment_timeout_sec: z.coerce.number().int().min(60).max(1800),
});

const voucherCreateSchema = z.object({
  code: z.string().trim().min(3, 'Kode 3-20 karakter').max(20).transform(s => s.toUpperCase()).refine(s => /^[A-Z0-9]+$/.test(s), 'Kode hanya huruf & angka'),
  type: z.enum(['fixed', 'free_shipping', 'percent']),
  description: z.string().trim().min(3, 'Deskripsi 3-120 karakter').max(120),
  value: z.coerce.number().int().min(0).max(100000).default(0),
  min_subtotal: z.coerce.number().int().min(0).max(1000000).default(0),
  product_id: z.preprocess(v => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().positive().nullable().optional()),
});

module.exports = {
  parseId,
  validateBody,
  loginSchema,
  registerSchema,
  profileSchema,
  passwordChangeSchema,
  complaintSchema,
  cartAddSchema,
  cartPatchSchema,
  voucherCheckSchema,
  orderCreateSchema,
  orderCancelSchema,
  rateSchema,
  storeSchema,
  productSchema,
  stockPatchSchema,
  activePatchSchema,
  rejectOrderSchema,
  offlineOrderSchema,
  adminSettingsSchema,
  voucherCreateSchema,
};
