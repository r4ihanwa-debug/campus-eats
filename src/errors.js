const { ZodError } = require('zod');

class AppError extends Error {
  constructor(status, code, message, fields = null) {
    super(message);
    this.status = status;
    this.code = code || 'BAD_REQUEST';
    this.fields = fields;
  }
}

function bad(message, status = 400, code = null, fields = null) {
  const defaultCode =
    status === 401 ? 'UNAUTHORIZED'
      : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
          : status === 409 ? 'CONFLICT'
            : status === 429 ? 'RATE_LIMITED'
              : 'BAD_REQUEST';
  throw new AppError(status, code || defaultCode, message, fields);
}

function formatZodError(err) {
  const fields = {};
  for (const issue of err.issues || []) {
    const key = issue.path && issue.path.length ? issue.path.join('.') : '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const firstMsg = err.issues?.[0]?.message || 'Input tidak valid';
  return { fields, message: firstMsg };
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    const { fields, message } = formatZodError(err);
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message,
        fields,
      },
    });
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Format JSON tidak valid',
      },
    });
  }

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Ukuran data terlalu besar',
      },
    });
  }

  if (err instanceof AppError || (err && Number.isInteger(err.status))) {
    const status = err.status || 400;
    const payload = {
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status === 500 ? 'Terjadi kesalahan pada server' : err.message,
    };
    if (err.fields) payload.fields = err.fields;
    return res.status(status).json({ error: payload });
  }

  if (process.env.NODE_ENV !== 'test') {
    console.error('[error]', err?.message || err);
  }
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan pada server',
    },
  });
}

module.exports = { AppError, bad, errorHandler };
