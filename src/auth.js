const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { q } = require('./db');
const { AppError } = require('./errors');

const COOKIE_NAME = 'ce_sid';
const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;
let devEphemeralSecret = null;

function getJwtSecret() {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured) {
    if (process.env.NODE_ENV === 'production' && configured.length < 32) {
      throw new Error('JWT_SECRET harus minimal 32 karakter di mode production');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET wajib diisi di mode production');
  }
  if (!devEphemeralSecret) {
    devEphemeralSecret = crypto.randomBytes(32).toString('hex');
  }
  return devEphemeralSecret;
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || `${TOKEN_TTL_SEC}s` }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  return null;
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: TOKEN_TTL_SEC * 1000,
  });
}

function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
  });
}

async function resolveUserFromRequest(req) {
  const token = extractToken(req);
  if (!token) return { user: null, token: null, errorCode: null };
  try {
    const payload = verifyToken(token);
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return { user: null, token, errorCode: 'INVALID_TOKEN' };
    }
    const user = await q.get('SELECT * FROM users WHERE id=? AND deleted=0', userId);
    if (!user) return { user: null, token, errorCode: 'INVALID_TOKEN' };
    if (!user.active) return { user: null, token, errorCode: 'ACCOUNT_DISABLED' };
    return { user, token, errorCode: null };
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      return { user: null, token, errorCode: 'TOKEN_EXPIRED' };
    }
    return { user: null, token, errorCode: 'INVALID_TOKEN' };
  }
}

async function optionalAuth(req, res, next) {
  try {
    const { user, token, errorCode } = await resolveUserFromRequest(req);
    req.user = user;
    req.token = token;
    req.authErrorCode = errorCode;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAuth(req, res, next) {
  try {
    const { user, token, errorCode } = await resolveUserFromRequest(req);
    if (!user) {
      if (errorCode === 'TOKEN_EXPIRED') {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Sesi login telah kedaluwarsa. Silakan masuk kembali.');
      }
      if (errorCode === 'ACCOUNT_DISABLED') {
        throw new AppError(403, 'ACCOUNT_DISABLED', 'Akun dinonaktifkan. Hubungi admin Campus Eats.');
      }
      throw new AppError(401, 'AUTH_REQUIRED', 'Silakan login terlebih dahulu.');
    }
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}

function expandRoles(roles) {
  const expanded = new Set();
  for (const r of roles) {
    if (r === 'staff') {
      expanded.add('merchant');
      expanded.add('courier');
      expanded.add('admin');
    } else {
      expanded.add(r);
    }
  }
  return expanded;
}

function requireRole(...roles) {
  const allowed = expandRoles(roles);
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(401, 'AUTH_REQUIRED', 'Silakan login terlebih dahulu.'));
    }
    if (!allowed.has(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'Kamu tidak punya akses ke fitur ini.'));
    }
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  TOKEN_TTL_SEC,
  getJwtSecret,
  signToken,
  verifyToken,
  extractToken,
  setAuthCookie,
  clearAuthCookie,
  optionalAuth,
  requireAuth,
  requireRole,
};
