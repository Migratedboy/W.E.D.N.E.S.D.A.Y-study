// ============================================================
// Auth primitives
// ============================================================
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash a password as `salt:scrypt`. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

/** Constant-time password verification. */
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return computed.length === hash.length && timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

/** Session tokens are only ever stored hashed. */
export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Constant-time comparison of six-digit codes. */
export function safeCompareCode(storedCode, submittedCode) {
  const a = Buffer.from(String(storedCode || "").padEnd(6, "0"));
  const b = Buffer.from(String(submittedCode || "").padEnd(6, "0"));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
