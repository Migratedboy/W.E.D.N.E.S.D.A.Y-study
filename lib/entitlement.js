// ============================================================
// Premium entitlement
// ============================================================
// One decision point, so the rule can be unit-tested and cannot silently drift
// between the rate limiter, the route handler and the client.
//
// Regression history: this used to trust an `x-dev-premium: 1` header from any
// client. Because the rate limiter skipped AI endpoints for "premium" requests,
// any logged-in user could get unlimited AI by adding one header in devtools.

/**
 * @param {object} req             request-ish object
 * @param {object} [opts]
 * @param {boolean} [opts.allowDevHeader=false]  honour the local dev toggle
 * @returns {boolean}
 */
export function isPremiumRequest(req, opts = {}) {
  if (!req) return false;

  // The only authoritative source: the users.is_premium column, attached to the
  // request by getUserFromRequest().
  if (req.user && req.user.is_premium === true) return true;

  // Local-development convenience ONLY. The caller decides whether this is
  // allowed; in production `allowDevHeader` is false.
  if (opts.allowDevHeader) {
    const raw = String(req.headers?.["x-dev-premium"] ?? req.headers?.["x-premium"] ?? "").toLowerCase();
    if (raw === "1" || raw === "true" || raw === "yes") return true;
  }

  return false;
}

/** Premium users get more AI throughput, but never unlimited. */
export const PREMIUM_RATE_MULTIPLIER = 5;

/** Endpoints whose limits are affected by entitlement. */
export function isAiRateLimitedPath(pathname) {
  return pathname === "/api/study" || pathname === "/api/learning-resources";
}

/** The effective request cap for a path. */
export function rateLimitFor(pathname, req, limits, fallback, opts = {}) {
  const base = limits[pathname] || fallback;
  return isPremiumRequest(req, opts) && isAiRateLimitedPath(pathname)
    ? base * PREMIUM_RATE_MULTIPLIER
    : base;
}
