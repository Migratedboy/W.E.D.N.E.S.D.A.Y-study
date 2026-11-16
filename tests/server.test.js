// ============================================================
// Integration tests: boot the real server.js against a mock Supabase
// ============================================================
// These cover the things that were actually exploitable, so a regression
// fails the build instead of quietly shipping:
//   * the premium gate (header bypass, server-side enforcement)
//   * client-forged quiz XP
//   * static-file serving of server-side code
//   * CSP delivery and the absence of inline-script reliance
//   * the new /css and /js mounts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createMockSupabase } from "./helpers/mock-supabase.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let mock;
let child;
let baseUrl;

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 401) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start in time");
}

before(async () => {
  mock = createMockSupabase();
  const mockPort = await mock.listen();

  // A verified free user and a verified premium user, each with a live session.
  mock.seed("users", [
    { email: "free@example.com", username: "freestudent", avatar: null, verified: true, is_premium: false },
    { email: "pro@example.com", username: "prostudent", avatar: null, verified: true, is_premium: true }
  ]);
  const freeToken = "free-token-0123456789";
  const proToken = "pro-token-0123456789";
  mock.seed("sessions", [
    { token: sha256(freeToken), email: "free@example.com", expires_at: new Date(Date.now() + 864e5).toISOString() },
    { token: sha256(proToken), email: "pro@example.com", expires_at: new Date(Date.now() + 864e5).toISOString() }
  ]);

  const port = 4600 + Math.floor(Math.random() * 300);
  baseUrl = "http://127.0.0.1:" + port;

  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production", // also proves the dev-only premium header path is off
      SUPABASE_URL: "http://127.0.0.1:" + mockPort,
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      AI_API_KEY: "",            // offline tutor fallback; no network calls
      AI_API_BASE_URL: "http://127.0.0.1:" + mockPort + "/v1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stderr.on("data", (d) => { if (process.env.DEBUG_SERVER) process.stderr.write(d); });

  await waitForServer(baseUrl + "/api/health");
  globalThis.__tokens = { freeToken, proToken };
});

after(async () => {
  if (child) child.kill("SIGKILL");
  if (mock) await mock.close();
});

const cookie = (token) => ({ cookie: "session=" + token });
const freeAuth = () => cookie(globalThis.__tokens.freeToken);
const proAuth = () => cookie(globalThis.__tokens.proToken);

// ---------- static assets ----------
test("index.html loads and references external css/js", async () => {
  const r = await fetch(baseUrl + "/", { headers: freeAuth() });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);
  assert.match(html, /<script src="\/js\/app\.js" defer><\/script>/);
  assert.ok(html.length < 40000, "index.html should no longer carry 200KB of inline css/js");
});

test("the app's css and js are served from the static mount", async () => {
  for (const path of ["/css/app.css", "/js/app.js", "/css/login.css", "/js/login.js"]) {
    const r = await fetch(baseUrl + path);
    assert.equal(r.status, 200, path + " should be served");
  }
});

test("static assets are cacheable, the app shell is not", async () => {
  const js = await fetch(baseUrl + "/js/app.js", { method: "HEAD" });
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control") || "", /max-age=3600/);

  const shell = await fetch(baseUrl + "/", { headers: freeAuth() });
  assert.match(shell.headers.get("cache-control") || "", /no-cache/);
});

test("server-side code is never downloadable", async () => {
  for (const path of ["/server.js", "//server.js", "/%2e%2e/server.js", "/lib/auth.js", "/package.json", "/.env", "/supabase_schema.sql"]) {
    const r = await fetch(baseUrl + path);
    assert.notEqual(r.status, 200, path + " must not be served");
  }
});

// ---------- CSP ----------
test("CSP is delivered as a header with no inline-script permission", async () => {
  const r = await fetch(baseUrl + "/", { headers: freeAuth() });
  const csp = r.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, "inline scripts must not be allowed");
  assert.match(csp, /img-src[^;]*https:\/\/\*\.supabase\.co/, "avatars live on supabase storage");
  assert.match(csp, /object-src 'none'/);
});

test("the duplicate meta CSP is gone", async () => {
  const html = await (await fetch(baseUrl + "/", { headers: freeAuth() })).text();
  assert.equal((html.match(/Content-Security-Policy/gi) || []).length, 0);
});

// ---------- auth ----------
test("an unauthenticated visitor gets the login page, not the app", async () => {
  const r = await fetch(baseUrl + "/");
  const html = await r.text();
  assert.match(html, /Sign in to continue studying/);
});

test("api routes reject anonymous requests", async () => {
  const r = await fetch(baseUrl + "/api/progress");
  assert.equal(r.status, 401);
});

test("a session token is only valid in its hashed form", async () => {
  // The raw token is what the cookie carries; the mock DB stores the hash.
  const viaRaw = await fetch(baseUrl + "/api/auth/me", { headers: cookie(globalThis.__tokens.freeToken) });
  assert.equal(viaRaw.status, 200);
  const viaHash = await fetch(baseUrl + "/api/auth/me", { headers: cookie(sha256(globalThis.__tokens.freeToken)) });
  assert.equal(viaHash.status, 401, "the stored hash must not itself work as a cookie");
});

// ---------- premium gate ----------
test("premium is not granted by a client-supplied header in production", async () => {
  const r = await fetch(baseUrl + "/api/learning-resources", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth(), "x-dev-premium": "1" },
    body: JSON.stringify({ topic: "linear algebra" })
  });
  assert.equal(r.status, 403, "the x-dev-premium bypass must be dead in production");
  const body = await r.json();
  assert.equal(body.upgradeRequired, true);
});

test("a free user is denied rather than merely rate-limited", async () => {
  const r = await fetch(baseUrl + "/api/learning-resources", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ topic: "anything" })
  });
  assert.equal(r.status, 403);
});

test("the entitlement comes from the users.is_premium column, not the client", async () => {
  // isPremiumRequest() is the single decision point. The integration suite runs
  // against the real module, so assert the rule directly rather than trying to
  // infer it from a downstream failure mode.
  const { isPremiumRequest } = await import("../lib/entitlement.js");

  const premiumUser = { user: { email: "pro@example.com", is_premium: true }, headers: {} };
  const freeUser = { user: { email: "free@example.com", is_premium: false }, headers: {} };
  const freeUserSpoofing = { user: { email: "free@example.com", is_premium: false }, headers: { "x-dev-premium": "1" } };

  assert.equal(isPremiumRequest(premiumUser, { allowDevHeader: false }), true);
  assert.equal(isPremiumRequest(freeUser, { allowDevHeader: false }), false);
  assert.equal(isPremiumRequest(freeUserSpoofing, { allowDevHeader: false }), false, "header must be ignored in production");
  assert.equal(isPremiumRequest(freeUserSpoofing, { allowDevHeader: true }), true, "dev toggle still works locally");
});

// ---------- quiz XP integrity ----------
test("the old self-reported score endpoint no longer awards XP", async () => {
  const before = (await (await fetch(baseUrl + "/api/progress", { headers: freeAuth() })).json()).totalXp || 0;

  const r = await fetch(baseUrl + "/api/quiz/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ subject: "Math", correct: 9999, total: 9999 })
  });
  assert.equal(r.status, 400, "a bare score claim is rejected for lack of an attemptId");

  const after = (await (await fetch(baseUrl + "/api/progress", { headers: freeAuth() })).json()).totalXp || 0;
  assert.equal(after, before, "forged scores must not move the leaderboard");
});

test("an unknown attemptId is rejected", async () => {
  const r = await fetch(baseUrl + "/api/quiz/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ attemptId: "doesnotexist123", answers: [0, 0, 0] })
  });
  assert.equal(r.status, 404);
});

test("grading is authoritative and single-use", async () => {
  // Seed an attempt the way /api/quiz/start would, with a known answer key.
  const attemptId = "attempt" + Date.now();
  const questions = [
    { question: "q1", options: ["a", "b"], correctIndex: 1, explanation: "one" },
    { question: "q2", options: ["a", "b"], correctIndex: 0, explanation: "two" }
  ];
  mock.seed("quiz_attempts", [
    { id: attemptId, user_email: "free@example.com", subject: "Math", questions, created_at: new Date().toISOString(), consumed_at: null }
  ]);

  const before = (await (await fetch(baseUrl + "/api/progress", { headers: freeAuth() })).json()).totalXp || 0;

  // Claiming everything was right does not matter: only the stored key counts.
  // Answers [1, 0] are correct; then lie about it with a claimed count.
  const graded = await fetch(baseUrl + "/api/quiz/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ attemptId, answers: [1, 1], correct: 9999, total: 9999 })
  });
  assert.equal(graded.status, 200);
  const result = await graded.json();
  assert.deepEqual(result.score, { correct: 1, total: 2 }, "one answer was wrong per the stored key");
  assert.equal(result.xpAwarded, 5, "1 correct * 5, no perfect bonus");

  const after = (await (await fetch(baseUrl + "/api/progress", { headers: freeAuth() })).json()).totalXp || 0;
  assert.equal(after, before + 5);

  // Replaying the same attempt must not award again.
  const replay = await fetch(baseUrl + "/api/quiz/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ attemptId, answers: [1, 0] })
  });
  assert.equal(replay.status, 409);

  const finalXp = (await (await fetch(baseUrl + "/api/progress", { headers: freeAuth() })).json()).totalXp || 0;
  assert.equal(finalXp, after, "a replayed attempt awards nothing");
});

test("one user cannot grade another user's attempt", async () => {
  const attemptId = "otheracttempt" + Date.now();
  mock.seed("quiz_attempts", [
    { id: attemptId, user_email: "pro@example.com", subject: "Math", questions: [{ question: "q", options: ["a", "b"], correctIndex: 0 }], consumed_at: null }
  ]);
  const r = await fetch(baseUrl + "/api/quiz/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...freeAuth() },
    body: JSON.stringify({ attemptId, answers: [0] })
  });
  assert.equal(r.status, 404, "scoped to the requesting user");
});

// ---------- health ----------
test("health reports configuration without leaking secrets", async () => {
  const r = await fetch(baseUrl + "/api/health");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.aiConfigured, false);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /test-service-role-key/);
});

test("no page relies on inline event handlers (the CSP forbids them)", async () => {
  const pages = ["/", "/login.html"];
  for (const page of pages) {
    const html = await (await fetch(baseUrl + page)).text();
    const inline = html.match(/\son(?:click|error|input|change|submit|load)=/gi) || [];
    assert.deepEqual(inline, [], page + " must not use inline handlers");
  }
});

test("every button id the login script binds to exists in the markup", async () => {
  const html = await (await fetch(baseUrl + "/login.html")).text();
  for (const id of ["tab-login", "tab-signup", "submit-btn", "verify-btn", "resend-btn", "back-btn", "username-btn"]) {
    assert.match(html, new RegExp('id="' + id + '"'), id + " is missing from login.html");
  }
});
