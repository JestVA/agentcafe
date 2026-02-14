import { randomUUID } from "node:crypto";

export const ERROR_CODES = {
  ERR_VALIDATION: { status: 400, message: "Validation failed" },
  ERR_MISSING_FIELD: { status: 400, message: "Required field missing" },
  ERR_NOT_FOUND: { status: 404, message: "Resource not found" },
  ERR_IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    message: "Idempotency-Key header is required for mutating requests"
  },
  ERR_IDEMPOTENCY_KEY_CONFLICT: {
    status: 409,
    message: "Idempotency key was reused with a different request payload"
  },
  ERR_RATE_LIMITED: { status: 429, message: "Rate limit exceeded" },
  ERR_FORBIDDEN: { status: 403, message: "Forbidden" },
  ERR_MODERATION_BLOCKED: { status: 429, message: "Moderation policy blocked action" },
  ERR_UNSUPPORTED_ACTION: { status: 404, message: "Unsupported action" },
  ERR_INTERNAL: { status: 500, message: "Internal error" }
};

export class AppError extends Error {
  constructor(code, message, details = {}, status) {
    const fallback = ERROR_CODES[code] || ERROR_CODES.ERR_INTERNAL;
    super(message || fallback.message);
    this.name = "AppError";
    this.code = code;
    this.status = status || fallback.status;
    this.details = details;
  }
}

export function getRequestId(req) {
  const existing = req.headers["x-request-id"];
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  return randomUUID();
}

export function normalizeError(error) {
  if (error instanceof SyntaxError) {
    return new AppError("ERR_VALIDATION", "Invalid JSON body", {
      cause: error.message
    });
  }
  if (error instanceof AppError) {
    return error;
  }
  return new AppError("ERR_INTERNAL", "Unexpected server error", {
    cause: error instanceof Error ? error.message : String(error)
  });
}

export function errorBody(error, requestId) {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details || {},
      requestId
    }
  };
}
