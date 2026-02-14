import { AppError } from "./errors.mjs";

export function requireString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("ERR_MISSING_FIELD", `Missing required field: ${field}`, { field });
  }
  return value.trim();
}

export function optionalString(body, field, fallback = undefined) {
  const value = body[field];
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new AppError("ERR_VALIDATION", `${field} must be a string`, { field });
  }
  return value;
}

export function optionalObject(body, field, fallback = {}) {
  const value = body[field];
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("ERR_VALIDATION", `${field} must be an object`, { field });
  }
  return value;
}
