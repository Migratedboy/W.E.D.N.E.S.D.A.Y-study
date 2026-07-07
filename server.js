// ============================================
// W.E.D.N.E.S.D.A.Y STUDY - Bulletproof Server
// (Supabase/Postgres-backed storage + email/password auth)
// ============================================
import path from 'node:path';
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

// ---------- Resolve paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const port = Number(process.env.PORT || 4174);

const env = loadEnv(join(root, ".env"));
const apiKey = (env.AI_API_KEY || process.env.AI_API_KEY || "").trim();
const baseUrl = stripSlash(env.AI_API_BASE_URL || process.env.AI_API_BASE_URL || "https://integrate.api.nvidia.com/v1");
// Ordered fallback chain of models. If an environment override (AI_MODELS) is
// provided, it takes precedence. Every AI call tries these in order and moves to
// the next one on failure - see getModelChain() and the retry loops in
// handleStudy()/generateRecommendationReason().
//
// Switched from OpenRouter to NVIDIA NIM (https://integrate.api.nvidia.com/v1) on
// 2026-07-05 - NVIDIA's build.nvidia.com free tier has no daily request cap (unlike
// OpenRouter's free-models-per-day limit, which was getting hit constantly), just
// standard rate limits, once the account's phone number is verified. Model slug
// confirmed against NVIDIA's own NIM docs/catalog: "meta/llama-3.1-70b-instruct".
const MODELS = (env.AI_MODELS || process.env.AI_MODELS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" 

];
const ACTIVE_MODELS = MODELS.length ? MODELS : DEFAULT_MODELS;

// ---------- AI request timeout / sizing config ----------
// ROOT CAUSE (see investigation notes on handleStudy() below): a single flat
// timeout does not account for how long NVIDIA's free-tier 70B model actually
// needs to generate a *large, non-streamed* completion (e.g. the 3000-token quiz
// JSON, or premiumLoop's review/rewrite passes). A short reply takes a couple of
// seconds; a long one can legitimately take 60-90s+ on the free tier. Rather than
// guessing one flat number, the timeout now scales with how much output was
// actually requested (max_tokens), with a hard floor and ceiling, and every
// value is overridable via env vars for ops tuning without a code change.
const AI_TIMEOUT_BASE_MS = Number(env.AI_TIMEOUT_BASE_MS || process.env.AI_TIMEOUT_BASE_MS || 20000); // fixed connect+prefill budget
const AI_TIMEOUT_PER_TOKEN_MS = Number(env.AI_TIMEOUT_PER_TOKEN_MS || process.env.AI_TIMEOUT_PER_TOKEN_MS || 30); // generation budget per requested output token
const AI_TIMEOUT_FLOOR_MS = Number(env.AI_TIMEOUT_FLOOR_MS || process.env.AI_TIMEOUT_FLOOR_MS || 30000);
const AI_TIMEOUT_CEILING_MS = Number(env.AI_TIMEOUT_CEILING_MS || process.env.AI_TIMEOUT_CEILING_MS || 120000);
// Escape hatch: if set, this fixed value wins over the formula entirely.
const AI_TIMEOUT_FIXED_MS = Number(env.AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 0) || null;

function computeRequestTimeoutMs(maxTokens) {
  if (AI_TIMEOUT_FIXED_MS) return AI_TIMEOUT_FIXED_MS;
  const scaled = AI_TIMEOUT_BASE_MS + (Number(maxTokens) || 0) * AI_TIMEOUT_PER_TOKEN_MS;
  return Math.max(AI_TIMEOUT_FLOOR_MS, Math.min(AI_TIMEOUT_CEILING_MS, Math.round(scaled)));
}

// Cheap, provider-agnostic token estimate (~4 chars/token for English) - good
// enough for logging/budgeting decisions, not meant to match the provider's
// exact tokenizer.
function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

// Caps the total character budget of chat history fed into a prompt, dropping
// the OLDEST messages first (keeping the most recent, most relevant turns) until
// the budget is met. This is independent of the existing "last 20 messages" cap:
// 20 short messages are fine, but 20 long ones (e.g. pasted essays/notes) can
// still blow up prompt size and therefore latency - see Deliverable #8.
const HISTORY_CHAR_BUDGET = Number(env.AI_HISTORY_CHAR_BUDGET || process.env.AI_HISTORY_CHAR_BUDGET || 12000);
function truncateHistoryToBudget(history, charBudget = HISTORY_CHAR_BUDGET) {
  let total = history.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  if (total <= charBudget) return { history, truncatedCount: 0 };
  const kept = [];
  let running = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const len = history[i].content ? history[i].content.length : 0;
    if (running + len > charBudget && kept.length > 0) break; // always keep at least the most recent turn
    kept.unshift(history[i]);
    running += len;
  }
  return { history: kept, truncatedCount: history.length - kept.length };
}
// Used only by the premium "AI Learning Resources" feature (YouTube search). Optional -
// if unset, that feature responds with a clear 503 instead of failing silently.
const youtubeApiKey = (env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY || "").trim();
const trustProxy = String(env.TRUST_PROXY || process.env.TRUST_PROXY || "0") === "1";
// Controls how much of the raw AI-provider error gets sent to the browser (see
// handleStudy's provider-error handling below). Defaults to "development" (full
// detail) unless NODE_ENV is explicitly "production", matching Node's usual convention.
const isDev = String(env.NODE_ENV || process.env.NODE_ENV || "development").toLowerCase() !== "production";
const trustedOrigins = new Set(
  (env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || `http://127.0.0.1:${port},http://localhost:${port}`)
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
);

// ---------- Supabase config ----------
const supabaseUrl = (env.SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
// IMPORTANT: this must be the SERVICE ROLE key (not the anon/public key). It is
// only ever used here on the server and must never be shipped to the browser.
const supabaseServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// ---------- Email (Gmail SMTP with app password) ----------
const gmailUser = (env.GMAIL_USER || process.env.GMAIL_USER || "").trim();
const gmailAppPassword = (env.GMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || "").trim();
const mailer = (gmailUser && gmailAppPassword)
  ? nodemailer.createTransport({ service: "gmail", auth: { user: gmailUser, pass: gmailAppPassword } })
  : null;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env - cannot start without a database.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

let dbReady = false;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://i.ytimg.com https://img.youtube.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';";

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// ---------- Supabase bootstrap ----------
async function connectSupabase() {
  // Cheap round-trip to confirm the URL/key are valid and the schema exists.
  const { error } = await supabase.from("users").select("email", { head: true, count: "exact" }).limit(1);
  if (error) {
    throw new Error(
      "Could not reach Supabase. " +
      "Did you run supabase_schema.sql in the Supabase SQL editor, and is SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY correct?"
    );
  }
  dbReady = true;
  console.log("[Supabase] Connected");
}

function throwIfError(error) {
  if (error) {
    console.error("[DB] error:", error);
    throw new Error("Database error.");
  }
}

// ---------- Chat sessions (Supabase, per user) ----------
async function listSessions(userEmail) {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("id,subject,title,updated_at")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false });
  throwIfError(error);
  return (data || []).map(r => ({ id: r.id, subject: r.subject, title: r.title, updatedAt: new Date(r.updated_at).getTime() }));
}

async function createChatSession(userEmail, subject) {
  const row = { id: generateId(), user_email: userEmail, subject: subject || "General", title: "New chat", updated_at: new Date().toISOString() };
  const { error } = await supabase.from("chat_sessions").insert(row);
  throwIfError(error);
  return { id: row.id, subject: row.subject, title: row.title, updatedAt: Date.now() };
}

async function touchSession(sessionId, userEmail, patch = {}) {
  const update = { updated_at: new Date().toISOString(), ...patch };
  const { error } = await supabase.from("chat_sessions").update(update).eq("id", sessionId).eq("user_email", userEmail);
  throwIfError(error);
}

async function deleteChatSession(sessionId, userEmail) {
  const { error } = await supabase.from("chat_sessions").delete().eq("id", sessionId).eq("user_email", userEmail);
  throwIfError(error);
}

async function getSessionMessages(sessionId, userEmail) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role,content,model,timestamp")
    .eq("session_id", sessionId)
    .eq("user_email", userEmail)
    .order("id", { ascending: true });
  throwIfError(error);
  return data || [];
}

// ---------- Chat history (Supabase, per user + per session) ----------
async function getChatHistory(userEmail, sessionId, limit = 80) {
  let query = supabase
    .from("chat_messages")
    .select("role,content,model,timestamp")
    .eq("user_email", userEmail);
  if (sessionId) query = query.eq("session_id", sessionId);
  const { data, error } = await query.order("id", { ascending: false }).limit(limit);
  throwIfError(error);
  return (data || []).reverse();
}

async function addChatMessages(userEmail, sessionId, messages) {
  if (!messages.length) return;
  const rows = messages.map(m => ({
    user_email: userEmail, session_id: sessionId || null, role: m.role, content: m.content, model: m.model || null, timestamp: m.timestamp
  }));
  const { error } = await supabase.from("chat_messages").insert(rows);
  throwIfError(error);
  await trimChatHistory(userEmail, sessionId);
}

async function trimChatHistory(userEmail, sessionId, max = 80) {
  let countQuery = supabase.from("chat_messages").select("id", { head: true, count: "exact" }).eq("user_email", userEmail);
  if (sessionId) countQuery = countQuery.eq("session_id", sessionId);
  const { count, error: countErr } = await countQuery;
  throwIfError(countErr);
  if (count > max) {
    const excess = count - max;
    let oldestQuery = supabase.from("chat_messages").select("id").eq("user_email", userEmail);
    if (sessionId) oldestQuery = oldestQuery.eq("session_id", sessionId);
    const { data: oldest, error } = await oldestQuery.order("id", { ascending: true }).limit(excess);
    throwIfError(error);
    const ids = (oldest || []).map(d => d.id);
    if (ids.length) {
      const { error: delErr } = await supabase.from("chat_messages").delete().in("id", ids);
      throwIfError(delErr);
    }
  }
}

// ---------- Flashcards (Supabase, per user) ----------
function rowToCard(row) {
  return {
    id: row.id, userEmail: row.user_email, subject: row.subject, front: row.front, back: row.back,
    ef: row.ef, repetitions: row.repetitions, interval: row.interval,
    nextReview: row.next_review, lastReviewed: row.last_reviewed,
    correctCount: row.correct_count, incorrectCount: row.incorrect_count
  };
}

function cardToRow(card) {
  return {
    subject: card.subject, front: card.front, back: card.back,
    ef: card.ef, repetitions: card.repetitions, interval: card.interval,
    next_review: card.nextReview, last_reviewed: card.lastReviewed,
    correct_count: card.correctCount, incorrect_count: card.incorrectCount
  };
}

async function listFlashcards({ subject, dueOnly, userEmail }) {
  let query = supabase.from("flashcards").select("*").eq("user_email", userEmail);
  if (subject && subject !== "General") query = query.eq("subject", subject);
  if (dueOnly) query = query.lte("next_review", new Date().toISOString());
  const { data, error } = await query;
  throwIfError(error);
  return (data || []).map(rowToCard);
}

async function createFlashcard({ front, back, subject, userEmail }) {
  const row = {
    id: generateId(), user_email: userEmail, subject: subject || "General", front, back,
    ef: 2.5, repetitions: 0, interval: 1,
    next_review: new Date().toISOString(), last_reviewed: null,
    correct_count: 0, incorrect_count: 0
  };
  const { error } = await supabase.from("flashcards").insert(row);
  throwIfError(error);
  return rowToCard(row);
}

async function getFlashcard(id, userEmail) {
  const { data, error } = await supabase.from("flashcards").select("*").eq("id", id).eq("user_email", userEmail).maybeSingle();
  throwIfError(error);
  return data ? rowToCard(data) : null;
}

async function saveFlashcard(card) {
  const { error } = await supabase.from("flashcards").update(cardToRow(card)).eq("id", card.id).eq("user_email", card.userEmail);
  throwIfError(error);
  return card;
}

// ---------- Progress (Supabase, per user) ----------
async function getProgress(userEmail) {
  const { data, error } = await supabase.from("progress").select("*").eq("user_email", userEmail).maybeSingle();
  throwIfError(error);
  if (!data) return { globalStreak: 0, lastStudyDate: null, subjects: {}, totalXp: 0 };
  return { globalStreak: data.global_streak, lastStudyDate: data.last_study_date, subjects: data.subjects || {}, totalXp: data.total_xp || 0 };
}

async function saveProgress(userEmail, progressData) {
  const row = {
    user_email: userEmail,
    global_streak: progressData.globalStreak,
    last_study_date: progressData.lastStudyDate,
    subjects: progressData.subjects,
    total_xp: progressData.totalXp || 0
  };
  const { error } = await supabase.from("progress").upsert(row, { onConflict: "user_email" });
  throwIfError(error);
}

// Adds XP to a user's running total (used by both the daily-study bonus and quiz rewards)
async function addXp(userEmail, amount) {
  if (!amount) return await getProgress(userEmail);
  const progressData = await getProgress(userEmail);
  progressData.totalXp = (progressData.totalXp || 0) + amount;
  await saveProgress(userEmail, progressData);
  return progressData;
}

// ---------- Leaderboard (Supabase, global, cached for 24h) ----------
const LEADERBOARD_TTL_MS = 24 * 60 * 60 * 1000;

async function computeLeaderboard(limit = 50) {
  const { data, error } = await supabase
    .from("progress")
    .select("user_email,total_xp,global_streak")
    .order("total_xp", { ascending: false })
    .limit(limit);
  throwIfError(error);
  const meta = await getUserMetaForEmails((data || []).map(r => r.user_email));
  return (data || []).map((row, i) => ({
    rank: i + 1,
    username: meta[row.user_email]?.username || "Anonymous",
    avatar: meta[row.user_email]?.avatar || null,
    xp: row.total_xp || 0,
    streak: row.global_streak || 0
  }));
}

// Looks up the chosen username + avatar (not emails) for a batch of user_email
// values, so the leaderboard can display real profiles instead of masked emails.
async function getUserMetaForEmails(emails) {
  const unique = [...new Set((emails || []).filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await supabase.from("users").select("email,username,avatar").in("email", unique);
  throwIfError(error);
  const map = {};
  (data || []).forEach(r => { map[r.email] = { username: r.username, avatar: r.avatar || null }; });
  return map;
}

async function getLeaderboard() {
  const { data: cache, error } = await supabase.from("leaderboard_cache").select("*").eq("id", "global").maybeSingle();
  throwIfError(error);

  const isStale = !cache || (Date.now() - new Date(cache.generated_at).getTime()) > LEADERBOARD_TTL_MS;
  if (!isStale) {
    return { entries: cache.entries || [], generatedAt: cache.generated_at };
  }

  const entries = await computeLeaderboard(50);
  const generatedAt = new Date().toISOString();
  const { error: upsertErr } = await supabase.from("leaderboard_cache").upsert(
    { id: "global", entries, generated_at: generatedAt },
    { onConflict: "id" }
  );
  throwIfError(upsertErr);
  return { entries, generatedAt };
}

async function getUserRank(userEmail) {
  const { data: self, error } = await supabase.from("progress").select("total_xp,global_streak").eq("user_email", userEmail).maybeSingle();
  throwIfError(error);
  const xp = self?.total_xp || 0;
  const { count, error: countErr } = await supabase
    .from("progress")
    .select("user_email", { head: true, count: "exact" })
    .gt("total_xp", xp);
  throwIfError(countErr);
  return { rank: (count || 0) + 1, xp, streak: self?.global_streak || 0 };
}

// ============================================
// AUTH (email + password, 6-digit email codes)
// ============================================
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return computed.length === hash.length && timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

function generateCode() {
  return String(randomInt(100000, 1000000)); // always 6 digits
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf("=");
    if (i === -1) return [p, ""];
    let value = p.slice(i + 1);
    try { value = decodeURIComponent(value); } catch { value = value; }
    return [p.slice(0, i), value];
  }));
}

function isSecureRequest(req) {
  return Boolean(
    process.env.FORCE_SECURE_COOKIE === "1" ||
    req.headers["x-forwarded-proto"] === "https" ||
    req.socket?.encrypted
  );
}

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function sessionCookie(token, req) {
  let cookie = "session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + SESSION_MAX_AGE_SECONDS;
  if (isSecureRequest(req)) cookie += "; Secure";
  return cookie;
}

function clearSessionCookie(req) {
  let cookie = "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
  if (isSecureRequest(req)) cookie += "; Secure";
  return cookie;
}

async function createSession(email) {
  const token = randomBytes(32).toString("hex");
  const { error } = await supabase.from("sessions").insert({
    token, email, expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });
  throwIfError(error);
  return token;
}

async function getUserFromRequest(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const { data: session, error } = await supabase.from("sessions").select("*").eq("token", token).maybeSingle();
  if (error || !session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  const { data: user } = await supabase.from("users").select("email,username,avatar").eq("email", session.email).eq("verified", true).maybeSingle();
  return user || null;
}

// Username rules: 3-20 chars, letters/numbers/underscores only, must start with a letter.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/;
// Avatars arrive from the client as small base64 data URLs (resized before upload).
// Anchored + charset-restricted so a crafted value can't break out of an HTML attribute.
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

// ---------- Avatar storage (Supabase Storage, NOT the Postgres DB) ----------
// Storage is billed/counted separately from the DB quota, so keeping avatar
// bytes out of a Postgres column is the single biggest DB-storage win we have.
const AVATAR_BUCKET = "avatars";
const AVATAR_MAX_BASE64_LEN = 200000; // ~150KB decoded - generous for an 80x80 q0.7 JPEG

function avatarPathForEmail(email, ext) {
  const hash = createHash("sha256").update(email).digest("hex");
  return hash + "." + ext;
}

async function uploadAvatar(email, dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid image data.");
  const [, rawExt, base64] = match;
  const ext = rawExt === "jpg" ? "jpeg" : rawExt;
  const contentType = "image/" + ext;
  const buffer = Buffer.from(base64, "base64");

  const path = avatarPathForEmail(email, ext === "jpeg" ? "jpg" : ext);
  const { error: uploadErr } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, buffer, { contentType, upsert: true, cacheControl: "3600" });
  throwIfError(uploadErr);

  const { data: pub } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  // Cache-bust so the browser picks up the new image immediately after a change.
  return pub.publicUrl + "?v=" + Date.now();
}

async function deleteAvatarFiles(email) {
  // Best-effort cleanup across possible extensions; ignore errors (file may not exist).
  const paths = ["jpg", "jpeg", "png", "webp"].map(ext => avatarPathForEmail(email, ext));
  try { await supabase.storage.from(AVATAR_BUCKET).remove(paths); } catch { /* ignore */ }
}

async function isUsernameTaken(username, exceptEmail) {
  let query = supabase.from("users").select("email").ilike("username", username);
  if (exceptEmail) query = query.neq("email", exceptEmail);
  const { data, error } = await query.limit(1);
  throwIfError(error);
  return Boolean(data && data.length);
}

async function setLoginCode(email) {
  const code = generateCode();
  const { error } = await supabase.from("users").update({
    code, code_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  }).eq("email", email);
  throwIfError(error);
  return code;
}

async function sendVerificationEmail(email, code, subjectLine) {
  if (!mailer) {
    console.warn("[Mail] Gmail SMTP not configured (set GMAIL_USER / GMAIL_APP_PASSWORD in .env). Verification codes will not be delivered by email.");
    return;
  }
  await mailer.sendMail({
    from: '"W.E.D.N.E.S.D.A.Y Study" <' + gmailUser + '>',
    to: email,
    subject: subjectLine + " - W.E.D.N.E.S.D.A.Y Study",
    text: "Your verification code is: " + code + "\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.",
    html: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">' +
      '<h2 style="color:#6c3ce9;letter-spacing:2px">W.E.D.N.E.S.D.A.Y STUDY</h2>' +
      '<p>' + subjectLine + '. Your verification code is:</p>' +
      '<p style="font-size:34px;font-weight:bold;letter-spacing:8px;text-align:center;color:#333">' + code + '</p>' +
      '<p style="color:#888;font-size:13px">This code expires in 10 minutes. If you did not request it, you can safely ignore this email.</p>' +
      '</div>'
  });
}

// ---------- Rate limiting (per IP, per endpoint) ----------
// Prevents brute-forcing the 6-digit verification code and password guessing.
// In-memory is fine for a single-instance deploy; swap for Redis if you scale out.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GLOBAL_RATE_LIMIT = 200;
const RATE_LIMITS = {
  "/api/auth/login": 10,
  "/api/auth/signup": 5,
  "/api/auth/verify": 10,
  "/api/auth/resend": 5,
  // Root-cause fix (Bug #1 / HTTP 429): 5 requests per 15-minute window is far too low
  // for a chat feature - a normal study session sends more than 5 messages in that
  // window, so as soon as isRateLimited() actually enforces this limit (see fix
  // above), non-premium users would get thrown a 429 after their first few messages.
  // Raised to a value that still stops abuse/runaway loops without blocking normal use.
  "/api/study": 40,
  "/api/learning-resources": 15,
  "/api/sessions": 20,
  "/api/flashcards": 20,
  "/api/flashcards/review": 20,
  "/api/progress/track": 30,
  "/api/quiz/complete": 20,
  "/api/auth/avatar": 10
};
const rateLimitBuckets = new Map();

function getClientIp(req) {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function createBucket(key) {
  const now = Date.now();
  const bucket = { start: now, count: 0 };
  rateLimitBuckets.set(key, bucket);
  return bucket;
}

function incrementBucket(key, limit) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = createBucket(key);
  }
  bucket.count++;
  return bucket.count > limit;
}

// Premium-aware route detection.
// Future Stripe entitlement logic should replace the header / request-based check below.
function isPremiumRequest(req) {
  if (!req || !req.headers) return false;

  // Backend-aware premium helper path: if the server already attaches premium status
  // to the request object, prefer that.
  if (typeof req.isPremium === 'function') return req.isPremium();
  if (req.user && typeof req.user.isPremium !== 'undefined') return Boolean(req.user.isPremium);
  if (req.session?.user && typeof req.session.user.isPremium !== 'undefined') return Boolean(req.session.user.isPremium);

  // Developer-mode passthrough for the current local premium toggle.
  const premiumHeader = String(req.headers['x-dev-premium'] || req.headers['x-premium'] || '').toLowerCase();
  return premiumHeader === '1' || premiumHeader === 'true' || premiumHeader === 'yes';
}

function isAiRateLimitedPath(pathname) {
  return pathname === '/api/study' || pathname === '/api/learning-resources';
}

function isRateLimited(pathname, req) {
  if (isPremiumRequest(req) && isAiRateLimitedPath(pathname)) {
    return false;
  }
  // Root-cause fix (Bug #1 / HTTP 429): this function body was an unfinished stub -
  // everything after the premium bypass had been replaced with a placeholder comment,
  // so it fell through and returned `undefined` (falsy) for every non-premium request.
  // RATE_LIMITS, incrementBucket(), and GLOBAL_RATE_LIMIT were all defined above but
  // never actually invoked anywhere in the file - the per-IP throttle was dead code
  // that could never fire predictably. Completing the implementation here restores
  // real, bounded per-IP/per-endpoint throttling instead of an all-or-nothing stub.
  const ip = getClientIp(req);
  const key = ip + ":" + pathname;
  const limit = RATE_LIMITS[pathname] || GLOBAL_RATE_LIMIT;
  return incrementBucket(key, limit);
}

// Periodic cleanup so the bucket map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.start > RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS);

function safeCompareCode(storedCode, submittedCode) {
  const a = Buffer.from(String(storedCode || "").padEnd(6, "0"));
  const b = Buffer.from(String(submittedCode || "").padEnd(6, "0"));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handleAuth(url, req, res) {
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const user = await getUserFromRequest(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in." });
    return sendJson(res, 200, { email: user.email, username: user.username, avatar: user.avatar || null });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  let body;
  try {
    body = await parseJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  // signup always keys off an email address. login/resend/verify/set-username can be
  // reached via a "identifier" field (email OR username) once an account exists.
  const email = String(body.email || "").trim().toLowerCase();

  if (url.pathname === "/api/auth/signup") {
    const password = String(body.password || "");
    if (!email) return sendJson(res, 400, { error: "Email required." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
    if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters." });

    const { data: existing } = await supabase.from("users").select("email,verified").eq("email", email).maybeSingle();
    if (existing && existing.verified) return sendJson(res, 409, { error: "An account with this email already exists. Please log in." });

    const { error: upsertErr } = await supabase.from("users").upsert(
      { email, password_hash: hashPassword(password), verified: false },
      { onConflict: "email" }
    );
    throwIfError(upsertErr);

    const code = await setLoginCode(email);
    await sendVerificationEmail(email, code, "Verify your new account");
    return sendJson(res, 200, { needsCode: true, message: "Verification code sent to " + email });
  }

  if (url.pathname === "/api/auth/login") {
    const identifier = String(body.identifier || body.email || "").trim();
    const password = String(body.password || "");
    if (!identifier) return sendJson(res, 400, { error: "Email or username required." });

    // Allow signing in with either the account email or the chosen username.
    const query = identifier.includes("@")
      ? supabase.from("users").select("*").eq("email", identifier.toLowerCase())
      : supabase.from("users").select("*").ilike("username", identifier);
    const { data: user } = await query.maybeSingle();
    if (!user || !verifyPassword(password, user.password_hash)) return sendJson(res, 401, { error: "Invalid email/username or password." });

    const code = await setLoginCode(user.email);
    await sendVerificationEmail(user.email, code, user.verified ? "Your login code" : "Verify your account");
    return sendJson(res, 200, { needsCode: true, message: "A 6-digit code was sent to " + user.email, email: user.email });
  }

  if (url.pathname === "/api/auth/resend") {
    if (!email) return sendJson(res, 400, { error: "Email required." });
    const { data: user } = await supabase.from("users").select("email").eq("email", email).maybeSingle();
    if (user) {
      const code = await setLoginCode(email);
      await sendVerificationEmail(email, code, "Your verification code");
    }
    return sendJson(res, 200, { message: "If an account exists for that email, a new code has been sent." });
  }

  if (url.pathname === "/api/auth/verify") {
    if (!email) return sendJson(res, 400, { error: "Email required." });
    const code = String(body.code || "").trim();
    const { data: user } = await supabase.from("users").select("code,code_expires_at,username").eq("email", email).maybeSingle();
    if (!user || !user.code || !safeCompareCode(user.code, code)) return sendJson(res, 400, { error: "Invalid code. Check your email and try again." });
    if (user.code_expires_at && new Date(user.code_expires_at) < new Date()) return sendJson(res, 400, { error: "Code expired. Request a new one." });

    const { error: verifyErr } = await supabase.from("users").update({ verified: true, code: null, code_expires_at: null }).eq("email", email);
    throwIfError(verifyErr);

    // A username is mandatory. If this account doesn't have one yet, don't log
    // them in yet - the frontend must call /api/auth/set-username first.
    if (!user.username) {
      return sendJson(res, 200, { success: true, needsUsername: true, email });
    }

    const token = await createSession(email);
    res.setHeader("Set-Cookie", sessionCookie(token, req));
    return sendJson(res, 200, { success: true, email, username: user.username });
  }

  if (url.pathname === "/api/auth/set-username") {
    if (!email) return sendJson(res, 400, { error: "Email required." });
    const username = String(body.username || "").trim();
    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: "Username must be 3-20 characters, start with a letter, and contain only letters, numbers, or underscores." });
    }

    const { data: user } = await supabase.from("users").select("email,verified,username").eq("email", email).maybeSingle();
    if (!user || !user.verified) return sendJson(res, 400, { error: "Verify your email before choosing a username." });
    if (user.username) return sendJson(res, 409, { error: "Username already set for this account." });

    if (await isUsernameTaken(username, email)) {
      return sendJson(res, 409, { error: "That username is already taken. Please choose another." });
    }

    const { error: setErr } = await supabase.from("users").update({ username }).eq("email", email);
    throwIfError(setErr);

    const token = await createSession(email);
    res.setHeader("Set-Cookie", sessionCookie(token, req));
    return sendJson(res, 200, { success: true, email, username });
  }

  if (url.pathname === "/api/auth/change-username") {
    const user = await getUserFromRequest(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in." });
    const username = String(body.username || "").trim();
    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: "Username must be 3-20 characters, start with a letter, and contain only letters, numbers, or underscores." });
    }
    if (await isUsernameTaken(username, user.email)) {
      return sendJson(res, 409, { error: "That username is already taken. Please choose another." });
    }
    const { error: err } = await supabase.from("users").update({ username }).eq("email", user.email);
    throwIfError(err);
    return sendJson(res, 200, { success: true, username });
  }

  if (url.pathname === "/api/auth/avatar") {
    const user = await getUserFromRequest(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in." });
    const avatar = String(body.avatar || "").trim();

    // Empty payload = remove the profile picture.
    if (!avatar) {
      await deleteAvatarFiles(user.email);
      const { error: clearErr } = await supabase.from("users").update({ avatar: null }).eq("email", user.email);
      throwIfError(clearErr);
      return sendJson(res, 200, { success: true, avatar: null });
    }

    if (!AVATAR_DATA_URL_RE.test(avatar)) return sendJson(res, 400, { error: "Invalid image data." });
    if (avatar.length > AVATAR_MAX_BASE64_LEN) return sendJson(res, 400, { error: "Image too large. Please pick a smaller picture." });

    let publicUrl;
    try {
      publicUrl = await uploadAvatar(user.email, avatar);
    } catch (e) {
      console.error("[Avatar] upload failed:", e.message);
      return sendJson(res, 500, { error: "Could not upload image. Please try again." });
    }

    // Store only the URL in Postgres - the image bytes live in Supabase Storage.
    const { error: err } = await supabase.from("users").update({ avatar: publicUrl }).eq("email", user.email);
    throwIfError(err);
    return sendJson(res, 200, { success: true, avatar: publicUrl });
  }

  if (url.pathname === "/api/auth/logout") {
    const token = parseCookies(req).session;
    if (token) await supabase.from("sessions").delete().eq("token", token);
    res.setHeader("Set-Cookie", clearSessionCookie(req));
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 404, { error: "Unknown auth endpoint." });
}

// ---------- Storage housekeeping ----------
// Sessions and unused verification codes are pure waste once expired - purge
// them regularly so they don't quietly eat into the DB storage quota.
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function cleanupExpired() {
  const nowIso = new Date().toISOString();
  try {
    const { error, count } = await supabase
      .from("sessions")
      .delete({ count: "exact" })
      .lt("expires_at", nowIso);
    if (error) console.error("[Cleanup] sessions:", error.message);
    else if (count) console.log("[Cleanup] Removed " + count + " expired session(s).");
  } catch (e) {
    console.error("[Cleanup] sessions failed:", e.message);
  }

  try {
    const { error, count } = await supabase
      .from("users")
      .update({ code: null, code_expires_at: null }, { count: "exact" })
      .lt("code_expires_at", nowIso)
      .not("code", "is", null);
    if (error) console.error("[Cleanup] verification codes:", error.message);
    else if (count) console.log("[Cleanup] Cleared " + count + " expired verification code(s).");
  } catch (e) {
    console.error("[Cleanup] verification codes failed:", e.message);
  }

  // Chat retention: sessions untouched for 30+ days are deleted (along with
  // their messages) to keep chat_messages from being the biggest storage hog.
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: staleSessions, error: findErr } = await supabase
      .from("chat_sessions")
      .select("id")
      .lt("updated_at", cutoff);
    if (findErr) {
      console.error("[Cleanup] stale sessions lookup:", findErr.message);
    } else if (staleSessions && staleSessions.length) {
      const ids = staleSessions.map(s => s.id);
      const { error: msgErr } = await supabase.from("chat_messages").delete().in("session_id", ids);
      if (msgErr) console.error("[Cleanup] stale chat messages:", msgErr.message);
      const { error: sessDelErr } = await supabase.from("chat_sessions").delete().in("id", ids);
      if (sessDelErr) console.error("[Cleanup] stale chat sessions:", sessDelErr.message);
      else console.log("[Cleanup] Deleted " + ids.length + " chat session(s) inactive for 30+ days.");
    }
  } catch (e) {
    console.error("[Cleanup] chat retention failed:", e.message);
  }
}

// ---------- Server ----------
async function main() {
  await connectSupabase();
  await cleanupExpired();
  setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1:" + port);

    const origin = String(req.headers.origin || "").trim();
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "interest-cohort=()");
    if (origin) {
      if (!trustedOrigins.has(origin)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden origin");
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (isSecureRequest(req)) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // --- AUTH API ENDPOINTS (public) ---
      if (url.pathname.startsWith("/api/" ) && req.method !== "OPTIONS") {
        if (isRateLimited(url.pathname, req)) {
          return sendJson(res, 429, { error: "Too many requests. Please wait a few minutes and try again." });
        }
      }

      if (url.pathname.startsWith("/api/auth/")) return await handleAuth(url, req, res);

      const user = await getUserFromRequest(req);

      if (url.pathname === "/api/health") {
        return sendJson(res, 200, {
          aiConfigured: Boolean(apiKey),
          youtubeConfigured: Boolean(youtubeApiKey),
          supabaseConfigured: Boolean(supabaseUrl && supabaseServiceKey),
          supabaseConnected: dbReady,
          baseUrl: baseUrl.replace(/^https?:\/\//, ""),
          models: getModelChain()
        });
      }

      // All remaining /api endpoints require a logged-in, verified user
      if (url.pathname.startsWith("/api/") && !user) {
        return sendJson(res, 401, { error: "Not logged in." });
      }

      if (url.pathname === "/api/study" && req.method === "POST") return await handleStudy(req, res, user.email);
 
      // Premium-only client feature (Loop Engineering's "AI Learning Resources"). Gating on
      // premium happens client-side (see DeveloperSettings.isPremium()); this endpoint itself
      // just requires a logged-in user, same as every other /api route below.
      if (url.pathname === "/api/learning-resources" && req.method === "POST") return await handleLearningResources(req, res);

      // --- CHAT SESSION (thread) API ENDPOINTS ---
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const list = await listSessions(user.email);
        return sendJson(res, 200, { sessions: list });
      }

      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const body = await parseJson(req);
        const subject = String(body.subject || "General").trim().slice(0, 50) || "General";
        const created = await createChatSession(user.email, subject);
        return sendJson(res, 201, { session: created });
      }

      const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && req.method === "GET") {
        const messages = await getSessionMessages(decodeURIComponent(sessionMessagesMatch[1]), user.email);
        return sendJson(res, 200, { messages });
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "DELETE") {
        await deleteChatSession(decodeURIComponent(sessionMatch[1]), user.email);
        return sendJson(res, 200, { success: true });
      }

      // --- FLASHCARD API ENDPOINTS ---
      if (url.pathname === "/api/flashcards" && req.method === "GET") {
        const subject = url.searchParams.get("subject");
        const dueOnly = url.searchParams.get("due") === "true";
        const cards = await listFlashcards({ subject, dueOnly, userEmail: user.email });
        return sendJson(res, 200, { flashcards: cards });
      }

      if (url.pathname === "/api/flashcards" && req.method === "POST") {
        const body = await parseJson(req);
        const { front, back, subject } = body;
        if (!front || !back) return sendJson(res, 400, { error: "Front and back required" });
        const newCard = await createFlashcard({ front: String(front).trim(), back: String(back).trim(), subject: String(subject || "General").trim(), userEmail: user.email });
        return sendJson(res, 201, { flashcard: newCard });
      }

      if (url.pathname === "/api/flashcards/review" && req.method === "POST") {
        const body = await parseJson(req);
        const { id, quality } = body; // quality: 0-5 (SM-2 standard)
        const card = await getFlashcard(String(id).trim(), user.email);
        if (!card) return sendJson(res, 404, { error: "Card not found" });

        let q = typeof quality === 'boolean' ? (quality ? 5 : 1) : Number(quality);
        if (isNaN(q)) q = 3;

        // SM-2 Algorithm Logic
        if (q < 3) {
          card.repetitions = 0; // Reset progress if struggled
          card.incorrectCount = (card.incorrectCount || 0) + 1;
          card.interval = 1;
        } else {
          card.correctCount = (card.correctCount || 0) + 1;
          if (card.repetitions === 0) card.interval = 1;
          else if (card.repetitions === 1) card.interval = 6;
          else card.interval = Math.round((card.interval || 1) * card.ef);
          card.repetitions++;
        }

        // Adjust Easiness Factor (EF)
        card.ef = (card.ef || 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
        if (card.ef < 1.3) card.ef = 1.3;

        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + (card.interval || 1));
        card.nextReview = nextDate.toISOString();
        card.lastReviewed = new Date().toISOString();

        const saved = await saveFlashcard(card);
        return sendJson(res, 200, { flashcard: saved });
      }

      // --- PROGRESS API ENDPOINTS ---
      if (url.pathname === "/api/progress" && req.method === "GET") {
        const progressData = await getProgress(user.email);
        return sendJson(res, 200, progressData);
      }

      if (url.pathname === "/api/progress/track" && req.method === "POST") {
        const body = await parseJson(req);
        const subject = String(body.subject || "General").trim().slice(0, 50) || "General";
        const topic = String(body.topic || "Study Session").trim().slice(0, 100) || "Study Session";

        const progressData = await getProgress(user.email);
        if (!progressData.subjects[subject]) {
          progressData.subjects[subject] = { topicsCovered: [], studyDays: [], xp: 0 };
        }

        const subjData = progressData.subjects[subject];
        const today = new Date().toISOString().split('T')[0];
        const wasNewDayOverall = progressData.lastStudyDate !== today;

        // Track topics covered
        if (topic && !subjData.topicsCovered.includes(topic)) {
          subjData.topicsCovered.push(topic);
        }

        // Track study days & award per-subject XP
        if (!subjData.studyDays.includes(today)) {
          subjData.studyDays.push(today);
          subjData.xp = (subjData.xp || 0) + 10;
        }

        // Update global streak
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        if (progressData.lastStudyDate === today) {
          // Already studied today
        } else if (progressData.lastStudyDate === yesterdayStr) {
          progressData.globalStreak += 1;
        } else {
          progressData.globalStreak = 1;
        }
        progressData.lastStudyDate = today;

        // Award global leaderboard XP once per day: a base amount for showing up,
        // plus a bonus that scales with (and rewards maintaining) the streak.
        let xpAwarded = 0;
        if (wasNewDayOverall) {
          const streakBonus = Math.min(progressData.globalStreak, 10) * 2; // caps at +20
          xpAwarded = 10 + streakBonus;
          progressData.totalXp = (progressData.totalXp || 0) + xpAwarded;
        }

        await saveProgress(user.email, progressData);
        return sendJson(res, 200, { success: true, progress: progressData, xpAwarded });
      }

      if (url.pathname === "/api/quiz/complete" && req.method === "POST") {
        const body = await parseJson(req);
        const subject = String(body.subject || "General").trim().slice(0, 50) || "General";
        const correct = Math.max(0, Number(body.correct) || 0);
        const total = Math.max(0, Number(body.total) || 0);

        // XP for quiz performance: points per correct answer, plus a perfect-score bonus.
        const perfectBonus = (total > 0 && correct === total) ? 25 : 0;
        const xpAwarded = correct * 5 + perfectBonus;

        const progressData = await getProgress(user.email);
        if (!progressData.subjects[subject]) {
          progressData.subjects[subject] = { topicsCovered: [], studyDays: [], xp: 0 };
        }
        progressData.subjects[subject].xp = (progressData.subjects[subject].xp || 0) + xpAwarded;
        progressData.totalXp = (progressData.totalXp || 0) + xpAwarded;

        await saveProgress(user.email, progressData);
        return sendJson(res, 200, { success: true, xpAwarded, totalXp: progressData.totalXp, progress: progressData });
      }

      if (url.pathname === "/api/leaderboard" && req.method === "GET") {
        const { entries, generatedAt } = await getLeaderboard();
        const you = await getUserRank(user.email);
        return sendJson(res, 200, { entries, generatedAt, you: { ...you, username: user.username || "Anonymous", avatar: user.avatar || null } });
      }

      // -----------------------------
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || !path.extname(url.pathname))) {
        // Not logged in -> serve the login page instead of the app
        if (!user) {
          const loginFile = join(root, "login.html");
          if (existsSync(loginFile)) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            createReadStream(loginFile).pipe(res);
            return;
          }
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("ERROR: login.html not found in: " + root);
          return;
        }
        const indexFile = findIndexFile();
        if (!indexFile) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("ERROR: No HTML file found in: " + root);
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        createReadStream(indexFile).pipe(res);
        return;
      }

      // Block direct access to app HTML files for logged-out visitors
      if (!user && extname(url.pathname).toLowerCase() === ".html" && !url.pathname.endsWith("login.html")) {
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      serveStatic(url.pathname, res);
    } catch (e) {
      console.error("[Server] Unhandled error:", e);
      return sendJson(res, 500, { error: "Internal server error." });
    }
  });

  // Root-cause fix (Bug #1 / ERR_EMPTY_RESPONSE): this was 60000ms, which is shorter
  // than the worst case of /api/study's own retry loop (up to 3 models x a 20s
  // per-model timeout = up to ~60s+ overhead for saving/lookups). When the total
  // legitimately ran past 60s, Node's socket-level `server.timeout` would silently
  // destroy the connection - no error handler runs, no response is ever written, and
  // the browser sees exactly `net::ERR_EMPTY_RESPONSE` / "Failed to fetch", even
  // though the AI answer had already been generated and saved successfully (matches
  // the reported symptom: answer visible after refresh, but the live request died).
  // 120s gives headroom above the model-chain's own worst case.
  server.timeout = 120000;
  server.keepAliveTimeout = 125000;
  server.headersTimeout = 125000;
  server.listen(port, "127.0.0.1", () => {
    console.log("===========================================");
    console.log("   W.E.D.N.E.S.D.A.Y  STUDY  APP   ");
    console.log("===========================================");
    console.log("  URL:    http://127.0.0.1:" + port);
    console.log("  AI:       " + (apiKey ? "Configured [OK]" : "MISSING [ERROR]"));
    console.log("  Supabase: " + (() => {
      try { return new URL(supabaseUrl).host; } catch { return "configured"; }
    })());
    console.log("  Mail:     " + (mailer ? "Gmail SMTP [OK]" : "NOT CONFIGURED (codes will print to console)"));
    console.log("===========================================\n");
  });
}

main().catch(err => {
  console.error("[Startup] Failed to start server:", err);
  process.exit(1);
});

// ============================================
// AI HANDLER
// ============================================
function buildOfflineTutorReply(message, subject) {
  const cleaned = String(message || "").trim().replace(/\s+/g, " ");
  const lower = cleaned.toLowerCase();
  // Defensive cap: if a caller chains this canned reply into a follow-up prompt
  // (which it should never do - see askAI.lastWasFallback in index.html - but this
  // guards against it anyway), truncate the echoed-back "topic" so a bad caller
  // can't produce an ever-growing, self-nesting prompt across repeated fallbacks.
  const topic = (cleaned || "your topic").slice(0, 120);

  let reply = "I’m running in offline tutor mode right now, so I can still help with a practical study response.\n\n";

  if (!cleaned) {
    reply += "Share the topic you want help with and I’ll break it into simple steps.";
    return reply;
  }

  if (lower.includes("quiz") || lower.includes("test") || lower.includes("practice")) {
    reply += "For " + topic + ", try a quick self-quiz: define the idea, give one example, and name one common mistake.\n\n";
  } else if (lower.includes("formula") || lower.includes("equation") || lower.includes("math")) {
    reply += "For " + topic + ", write the formula, explain each variable, and solve one example step by step.\n\n";
  } else if (lower.includes("explain") || lower.includes("what is") || lower.includes("why")) {
    reply += "For " + topic + ", start with a one-sentence definition, then add 3 key points and one example.\n\n";
  } else {
    reply += "For " + topic + ", break it into four parts: a simple definition, a short example, one common error to avoid, and one practice question.\n\n";
  }

  reply += "If the AI service comes back, I can expand this into a more detailed explanation or turn it into flashcards.";
  return reply;
}

async function handleStudy(req, res, userEmail) {
  if (!apiKey) return sendJson(res, 503, { error: "AI_API_KEY not set." });

  // ---- Response-lifecycle guard ----
  // `responded` flips to true the instant we've committed to a single response for
  // this request - either a plain sendJson(), or writeHead() on the streaming path.
  // Every exit point below goes through respond() so it is structurally impossible
  // to send (or attempt to send) a second response on the same connection, which is
  // what previously crashed the whole process.
  let responded = false;
  function respond(status, data) {
    if (responded) {
      console.error("[Study] BLOCKED an attempted second response (status " + status + "):", data);
      return;
    }
    responded = true;
    console.log("Preparing response");
    console.log("Sending response");
    sendJson(res, status, data);
    console.log("Response sent");
  }

  console.log("Request received");

  try {
    const body = await parseJson(req);
    const message = String(body.message || "").trim().slice(0, 2000);
    let subject = String(body.subject || "General").trim().slice(0, 50);
    subject = subject.replace(/[^-\w\s\-\.,]/g, "").trim() || "General";
    const sysp = "You are an expert tutor for " + subject + ". You provide clear explanations, examples, and structured answers.";

    let temperature = Number(body.temperature);
    if (Number.isNaN(temperature)) temperature = 0.4;
    temperature = Math.max(0, Math.min(1, temperature));

    // Callers generating long structured output (e.g. a 5-question quiz as JSON)
    // can ask for a bigger completion budget than the 2000-token default, which was
    // sometimes cutting the quiz JSON off mid-array before the closing "]".
    let maxTokens = Number(body.maxTokens);
    if (!Number.isFinite(maxTokens)) maxTokens = 2000;
    maxTokens = Math.max(200, Math.min(4000, Math.round(maxTokens)));

    // ---- Image attachments (vision) ----
    // The client sends attached images as data: URLs (base64). We validate them the
    // same way avatar uploads are validated, then fold them into the user turn as
    // OpenAI-style content blocks so vision-capable models (e.g. NVIDIA's
    // nemotron-3-nano-omni) actually receive the pixels instead of just a filename.
    const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const MAX_IMAGES_PER_MESSAGE = 3;
    const MAX_IMAGE_BASE64_LEN = 4500000; // ~3.3MB decoded per image
    const images = (Array.isArray(body.images) ? body.images : [])
      .filter(u => typeof u === "string" && u.length <= MAX_IMAGE_BASE64_LEN && IMAGE_DATA_URL_RE.test(u))
      .slice(0, MAX_IMAGES_PER_MESSAGE);

    if (!message && !images.length) return respond(400, { error: "Message required." });

    const wantStream = body.stream === true;

    // Internal/self-contained calls (e.g. the quiz generator, or the review/rewrite
    // passes in premiumLoop) pass noSave: true. These aren't real chat turns the
    // user should see - they're one-off prompts whose only output is consumed
    // programmatically (parsed JSON, an intermediate draft, etc). Without this flag
    // every one of those calls would create a brand-new chat session (since none of
    // them was given a sessionId), which then shows up in the visible chat/recent
    // list on the left, polluting it with raw JSON. So when noSave is set, skip all
    // session creation, history lookup, and persistence entirely.
    const noSave = body.noSave === true;

    let sessionId = String(body.sessionId || "").trim();
    if (!/^[a-z0-9]+$/i.test(sessionId)) sessionId = "";
    let isFirstMessage = false;
    let trimmedHistory = [];

    if (!noSave) {
      if (!sessionId) {
        const newSession = await createChatSession(userEmail, subject);
        sessionId = newSession.id;
      }

      const storedHistory = await getChatHistory(userEmail, sessionId, 80);
      isFirstMessage = storedHistory.length === 0;

      const last20 = storedHistory
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }));

      // Deliverable #6/#8: 20 messages can still be huge in characters (long pasted
      // notes/essays in chat), which directly drives up NVIDIA generation latency.
      // Cap the total history char budget too, dropping the oldest turns first.
      const budgeted = truncateHistoryToBudget(last20);
      trimmedHistory = budgeted.history;
      if (budgeted.truncatedCount > 0) {
        console.warn("[Study] History truncated for size:", budgeted.truncatedCount, "oldest message(s) dropped, budget", HISTORY_CHAR_BUDGET, "chars");
      }
    } else {
      sessionId = "";
    }

    // If images are attached, the CURRENT user turn's content becomes an array of
    // content blocks (OpenAI/NIM vision format) instead of a plain string. History
    // and persistence still use the plain-text `message` - we never store the raw
    // image bytes back into chat history, only send them for this one request.
    const userContent = images.length
      ? [
          { type: "text", text: message || "Describe what is in the attached image(s)." },
          ...images.map(url => ({ type: "image_url", image_url: { url } }))
        ]
      : message;

    const messages = [{ role: "system", content: sysp }, ...trimmedHistory, { role: "user", content: userContent }];

    // Plain-text stand-in for the user turn when persisting to chat history - keeps
    // history/DB storage image-free while still showing something sensible for an
    // image-only message instead of a blank bubble.
    const savedMessageText = message || (images.length ? "[Sent " + images.length + " image(s)]" : "");

    if (!apiKey) {
      const fallbackReply = buildOfflineTutorReply(message, subject);
      if (!noSave) {
        try {
          await addChatMessages(userEmail, sessionId, [
            { role: "user", content: savedMessageText, timestamp: Date.now() },
            { role: "assistant", content: fallbackReply, model: "offline-fallback", timestamp: Date.now() }
          ]);
          await touchSession(sessionId, userEmail, isFirstMessage ? { title: truncateTitle(savedMessageText) } : {});
        } catch (saveErr) {
          console.error("[Study] Failed to save offline fallback reply:", saveErr);
        }
      }
      return respond(200, { reply: fallbackReply, model: "offline-fallback", sessionId, fallback: true });
    }

    const modelChain = getModelChain();
    let lastError = null;
    let lastProviderDetail = null; // richest detail we have, used to build the final error response
    const attempts = []; // one entry per model tried, for full dev-mode diagnostics

    for (const model of modelChain) {
      const attemptNumber = attempts.length + 1;

      // ROOT CAUSE FIX (Deliverables #1/#5/#7): the previous flat 60000ms timeout
      // was the same regardless of how much output was requested. /api/learning-
      // resources' AI call (generateRecommendationReason) always succeeds because
      // it asks for max_tokens: 80 with a two-message prompt - it finishes in a
      // couple of seconds on any tier. handleStudy, by contrast, is used both for
      // normal short chat replies AND for index.html's non-streaming premium
      // pipeline (askAI/premiumLoop review+rewrite passes, and the 5-question quiz
      // generator), which request up to max_tokens: 3000-4000 with no client-side
      // streaming - so the server must wait for the ENTIRE completion before it
      // can respond. On NVIDIA's free-tier 70B model that routinely exceeds 60s,
      // which is exactly what the "Timed out waiting for meta/llama-3.1-70b-
      // instruct" log line was capturing. The timeout below now scales with the
      // requested max_tokens (see computeRequestTimeoutMs), so a quick chat reply
      // still fails fast while a 3000-token quiz/rewrite gets real headroom.
      const requestBody = JSON.stringify({ model, messages, temperature: temperature, max_tokens: maxTokens, stream: wantStream });
      // m.content is a plain string for every message except the current turn when
      // images are attached (array of content blocks) - stringify defensively so
      // this estimate never throws, it's only used for logging/telemetry.
      const promptTokenEstimate = estimateTokens(
        messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
      );
      const timeoutMs = computeRequestTimeoutMs(maxTokens);

      console.log("Trying model...", model);
      console.log(
        "[Study] Request telemetry - attempt:", attemptNumber,
        "| model:", model,
        "| bodyBytes:", requestBody.length,
        "| estPromptTokens:", promptTokenEstimate,
        "| maxTokens:", maxTokens,
        "| stream:", wantStream,
        "| timeoutMs:", timeoutMs,
        "| historyMessages:", trimmedHistory.length
      );

      // Fresh AbortController EVERY iteration (Deliverable #7): an aborted
      // controller's signal can never be un-aborted, so reusing one across retries
      // would make every retry after the first fail instantly. Declaring it inside
      // the loop body (as before) already guarantees this, and clearTimeout() in
      // the finally block below prevents a stale timer from firing on a later,
      // unrelated iteration or leaking after success.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const r = await fetch(baseUrl + "/chat/completions", {
          method: "POST",
          headers: { "authorization": "Bearer " + apiKey, "content-type": "application/json" },
          body: requestBody,
          signal: controller.signal
        });
        console.log("[Study] Response headers received for", model, "after", (Date.now() - startedAt) + "ms", "- status:", r.status);

        // ---- Streaming path - forward tokens to the browser as SSE ----
        if (wantStream && r.ok && r.body) {
          // writeHead() commits the response right here - status/headers can never be
          // changed again after this line, so from this point on we must NOT call
          // sendJson() (which would try to writeHead again and throw
          // ERR_HTTP_HEADERS_SENT). Mark it immediately so a later error can only ever
          // log, never attempt a second response.
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-accel-buffering": "no"
          });
          responded = true;

          let full = "";
          let buffer = "";
          const decoder = new TextDecoder();

          try {
            for await (const chunk of r.body) {
              buffer += decoder.decode(chunk, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop(); // keep incomplete line for next chunk
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const payload = t.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                  const j = JSON.parse(payload);
                  const delta = j?.choices?.[0]?.delta?.content;
                  if (delta) {
                    full += delta;
                    res.write("data: " + JSON.stringify({ delta }) + "\n\n");
                  }
                } catch { /* ignore malformed SSE lines */ }
              }
            }
          } catch (streamErr) {
            res.write("data: " + JSON.stringify({ error: "Stream interrupted: " + streamErr.message }) + "\n\n");
          }

          const reply = cleanReply(full, !noSave);
          console.log("AI generated");
          console.log("Model succeeded...", model);

          // Saving is isolated in its own try/catch: headers are already sent, so a
          // save failure here must NEVER cascade into another sendJson() call (that's
          // the exact bug that used to crash the whole process for every other
          // in-flight request). Worst case on a save failure: the reply the user
          // already received in the stream doesn't persist to history - logged, but
          // the response still ends cleanly with exactly one "done" event.
          if (reply && !noSave) {
            try {
              await addChatMessages(userEmail, sessionId, [
                { role: "user", content: savedMessageText, timestamp: Date.now() },
                { role: "assistant", content: reply, model, timestamp: Date.now() }
              ]);
              await touchSession(sessionId, userEmail, isFirstMessage ? { title: truncateTitle(savedMessageText) } : {});
              console.log("Answer saved");
              console.log("Saved to database");
            } catch (saveErr) {
              console.error("[Study] Failed to save streamed reply (headers already sent, continuing without a second response):", saveErr);
            }
          }
          console.log("Sending response");
          res.write("data: " + JSON.stringify({ done: true, model, sessionId }) + "\n\n");
          res.end();
          console.log("Response sent");
          return;
        }

        const respData = await (async () => {
          const raw = await r.text().catch(() => "");
          // Log enough to tell "provider truly sent an empty body" apart from
          // "provider sent a rate-limit signal we weren't looking at". Free-tier
          // OpenRouter models sometimes signal quota exhaustion with a 200 status and
          // an empty/near-empty body instead of a proper 429 - the only way to catch
          // that is to look at the raw text and the rate-limit headers directly.
          const rlHeaders = {};
          for (const [k, v] of r.headers.entries()) {
            if (/ratelimit|retry-after|x-openrouter/i.test(k)) rlHeaders[k] = v;
          }
          if (Object.keys(rlHeaders).length) console.error("[Study] Rate-limit headers for", model, ":", JSON.stringify(rlHeaders));
          console.error("[Study] Raw response body for", model, "(" + raw.length + " chars):", raw.slice(0, 500));
          try {
            return raw ? JSON.parse(raw) : {};
          } catch (parseErr) {
            console.error("[Study] Response body was not valid JSON for", model, "-", parseErr.message);
            return {};
          }
        })();
        const hasUsablePayload = hasUsableChatCompletionPayload(respData);

        if (r.ok && hasUsablePayload) {
          const reply = cleanReply(respData.choices[0].message.content, !noSave);
          console.log("AI generated");
          console.log("Model succeeded...", model);
          console.log("[Study] Success telemetry:", JSON.stringify({
            model, attemptNumber, elapsedMs: Date.now() - startedAt, timeoutMs,
            maxTokens, promptTokenEstimate, responseChars: reply.length, status: r.status
          }));

          // Same isolation as the streaming path above, for the same reason: a save
          // failure is a persistence problem, not an AI-generation failure, and must
          // never be treated as "this model failed" (which would otherwise retry a
          // different model and eventually fall through to a duplicate response).
          // Skipped entirely for noSave requests (e.g. quiz generation) - see the
          // noSave comment above for why these must never touch chat history.
          if (!noSave) {
            try {
              await addChatMessages(userEmail, sessionId, [
                { role: "user", content: savedMessageText, timestamp: Date.now() },
                { role: "assistant", content: reply, model, timestamp: Date.now() }
              ]);
              await touchSession(sessionId, userEmail, isFirstMessage ? { title: truncateTitle(savedMessageText) } : {});
              console.log("Answer saved");
              console.log("Saved to database");
            } catch (saveErr) {
              console.error("[Study] Failed to save reply to history (reply still returned to client):", saveErr);
            }
          }

          return respond(200, { reply, model, sessionId });
        }
        lastError = respData?.error?.message || (r.ok ? "Provider returned an empty or invalid response." : "HTTP " + r.status);

        // Task requirement: log the COMPLETE provider response, not just a
        // one-line summary, so the exact reason for rejection is visible in
        // server logs regardless of which provider (OpenRouter/OpenAI/Groq/
        // Gemini) is configured - they all return roughly {error:{message,type,code}}.
        console.error("[Study] Provider error for model", model);
        console.error("Provider status:", r.status);
        console.error("Provider response:", JSON.stringify(respData));
        console.error("Provider error message:", respData?.error?.message || null);
        console.error("Provider error code:", respData?.error?.code || respData?.error?.type || null);
        console.error("Provider reason:", explainProviderError(r.status, respData));

        lastProviderDetail = {
          model,
          status: r.status,
          code: respData?.error?.code || respData?.error?.type || null,
          message: respData?.error?.message || null,
          reason: explainProviderError(r.status, respData),
          body: respData
        };
        attempts.push(lastProviderDetail);

        if (r.ok && !hasUsablePayload) {
          console.log("Model returned empty/invalid payload...", model);
          const nextModel = modelChain[modelChain.indexOf(model) + 1];
          if (nextModel) console.log("Switching to...", nextModel);
          continue;
        }

        if (r.status === 429 || r.status === 404 || r.status === 503) {
          console.log("Model failed...", model, "- HTTP", r.status);
          const nextModel = modelChain[modelChain.indexOf(model) + 1];
          if (nextModel) console.log("Switching to...", nextModel);
          continue;
        }

        if (r.status !== 404 && r.status !== 429 && r.status !== 503) {
          // Root-cause fix (Bug #3 / generic "Provider returned error"): return the
          // real provider message instead of a made-up generic string, and include
          // full detail in development mode so the actual rejection reason is visible
          // to whoever is debugging, without leaking it to end users in production.
          return respond(r.status, {
            error: lastError,
            ...(isDev ? { providerDetail: lastProviderDetail } : {})
          });
        }
      } catch (innerErr) {
        const elapsedMs = Date.now() - startedAt;
        lastError = innerErr.name === "AbortError"
          ? "Timed out waiting for " + model + " after " + elapsedMs + "ms (timeout budget " + timeoutMs + "ms)"
          : "Network error: " + innerErr.message;
        // Deliverable #11: structured diagnostics instead of a bare "AbortError" -
        // this is the single log line that would have made the root cause visible
        // immediately (timeoutMs vs elapsedMs vs maxTokens/promptTokenEstimate).
        console.error("[Study] Provider call failed:", JSON.stringify({
          model,
          attemptNumber,
          elapsedMs,
          timeoutMs,
          maxTokens,
          promptTokenEstimate,
          bodyBytes: requestBody.length,
          errorType: innerErr.name,
          errorMessage: innerErr.message
        }));
        lastProviderDetail = {
          model, status: null, code: innerErr.name || null, message: innerErr.message,
          reason: explainProviderError(null, null), body: null,
          elapsedMs, timeoutMs, attemptNumber
        };
        attempts.push(lastProviderDetail);
        console.log("Model failed...", model, "-", lastError);
        const nextModel = modelChain[modelChain.indexOf(model) + 1];
        if (nextModel) console.log("Switching to...", nextModel);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // All models in the fallback chain were tried and none succeeded (429/404/503
    // across the board, or network/timeout failures). Requirement: return one clear,
    // single explanation for the end user rather than the last model's raw error -
    // the real detail is still preserved for debugging via lastError/attempts in dev.
    console.error("[Study] All models exhausted. Attempts:", JSON.stringify(attempts));
    const fallbackReply = buildOfflineTutorReply(message, subject);
    if (!noSave) {
      try {
        await addChatMessages(userEmail, sessionId, [
          { role: "user", content: savedMessageText, timestamp: Date.now() },
          { role: "assistant", content: fallbackReply, model: "offline-fallback", timestamp: Date.now() }
        ]);
        await touchSession(sessionId, userEmail, isFirstMessage ? { title: truncateTitle(savedMessageText) } : {});
      } catch (saveErr) {
        console.error("[Study] Failed to save offline fallback reply after exhausting models:", saveErr);
      }
    }
    return respond(200, {
      reply: fallbackReply,
      model: "offline-fallback",
      sessionId,
      fallback: true,
      ...(isDev ? { lastError, providerDetail: lastProviderDetail, attempts } : {})
    });
  } catch (e) {
    console.error("[Study] Unhandled error:", e);
    return respond(500, { error: "Internal server error." });
  }
}

function truncateTitle(text) {
  return text.length > 42 ? text.slice(0, 42) + "…" : text;
}

// ============================================
// AI LEARNING RESOURCES (YouTube) - premium client feature
// ============================================
// Converts an ISO 8601 duration (e.g. "PT14M32S") into "14:32" / "1:02:03".
function formatIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ""));
  if (!m) return "";
  const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
  const mm = h > 0 ? String(min).padStart(2, "0") : String(min);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? (h + ":" + mm + ":" + ss) : (mm + ":" + ss);
}

// Simple relevance+popularity ranking: earlier search results are already relevance-sorted
// by YouTube, so blend that rank with (log-scaled) view count rather than trusting either alone.
function rankVideos(videos) {
  const maxViews = Math.max(1, ...videos.map(v => v.viewCount || 0));
  return videos
    .map((v, i) => {
      const relevance = 1 - i / videos.length; // 1.0 (first result) -> ~0 (last)
      const popularity = Math.log10((v.viewCount || 0) + 1) / Math.log10(maxViews + 1);
      return { ...v, score: relevance * 0.6 + popularity * 0.4 };
    })
    .sort((a, b) => b.score - a.score);
}

async function generateRecommendationReason(topic, video) {
  if (!apiKey) return "Closely matches the topic and has strong watch metrics among the search results.";
  const sysp = "You explain in ONE short sentence (max 25 words) why a specific YouTube video is a good learning resource for a student's topic. Be concrete - reference the title, channel, or popularity. No preamble.";
  const userMsg = "Topic: " + topic + "\nVideo title: " + video.title + "\nChannel: " + video.channel + "\nViews: " + (video.viewCount || "unknown");
  const modelChain = getModelChain();
  const reqMaxTokens = 80;
  for (const model of modelChain) {
    console.log("Trying model...", model);
    // This call previously had NO AbortController at all - a stalled/hanging
    // connection here would wait indefinitely. It always "worked" in practice
    // only because its prompt/output are tiny (2 short messages, max_tokens: 80),
    // not because it was actually protected. Adding a short bound (scaled the
    // same way as handleStudy, but naturally small given max_tokens: 80) makes
    // that reliability explicit instead of accidental, and keeps this endpoint
    // fast even if NVIDIA is degraded.
    const controller = new AbortController();
    const timeoutMs = computeRequestTimeoutMs(reqMaxTokens);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const r = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "authorization": "Bearer " + apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: sysp }, { role: "user", content: userMsg }],
          temperature: 0.4,
          max_tokens: reqMaxTokens
        }),
        signal: controller.signal
      });
      const data = await r.json().catch(() => ({}));
      const reply = data?.choices?.[0]?.message?.content;
      const elapsedMs = Date.now() - startedAt;
      if (r.ok && reply) {
        console.log("Model succeeded...", model);
        console.log("[LearningResources] AI 'why' telemetry:", JSON.stringify({ model, elapsedMs, timeoutMs, status: r.status }));
        return cleanReply(reply).replace(/^["“]|["”]$/g, "");
      }
      console.log("Model failed...", model, "- HTTP", r.status, "- elapsedMs:", elapsedMs);
      const nextModel = modelChain[modelChain.indexOf(model) + 1];
      if (nextModel) console.log("Switching to...", nextModel);
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      const reason = e.name === "AbortError" ? "Timed out after " + elapsedMs + "ms (budget " + timeoutMs + "ms)" : e.message;
      console.log("Model failed...", model, "-", reason);
      const nextModel = modelChain[modelChain.indexOf(model) + 1];
      if (nextModel) console.log("Switching to...", nextModel);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return "Closely matches the topic and has strong watch metrics among the search results.";
}

async function handleLearningResources(req, res) {
  console.log("[LearningResources] request received");
  // Same one-response guard as handleStudy: this endpoint is fully isolated from the
  // AI chat pipeline (separate route, separate request), but we still make it
  // structurally impossible to double-respond so a YouTube-side bug here can never
  // take down the shared Node process and affect /api/study or anything else.
  let responded = false;
  function respond(status, data) {
    if (responded) {
      console.error("[LearningResources] BLOCKED an attempted second response (status " + status + "):", data);
      return;
    }
    responded = true;
    sendJson(res, status, data);
  }
  if (!youtubeApiKey) {
    console.warn("[LearningResources] YOUTUBE_API_KEY not set - aborting before any search.");
    return respond(503, { error: "YOUTUBE_API_KEY not set." });
  }
  try {
    const body = await parseJson(req);
    const topic = String(body.topic || "").trim().slice(0, 150);
    console.log("[LearningResources] topic:", JSON.stringify(topic));
    if (!topic) {
      console.warn("[LearningResources] empty topic - rejecting.");
      return respond(400, { error: "Topic required." });
    }

    const searchUrl = "https://www.googleapis.com/youtube/v3/search"
      + "?part=snippet&type=video&maxResults=8&safeSearch=strict&relevanceLanguage=en"
      + "&q=" + encodeURIComponent(topic + " tutorial explained")
      + "&key=" + encodeURIComponent(youtubeApiKey);

    console.log("[LearningResources] calling YouTube search API...");
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json().catch(() => ({}));
    console.log("[LearningResources] search API status:", searchResp.status, "items returned:", (searchData.items || []).length);
    if (!searchResp.ok) {
      console.error("[LearningResources] YouTube search failed:", searchData?.error?.message || searchData);
      return respond(502, { error: searchData?.error?.message || "YouTube search failed." });
    }

    const items = (searchData.items || []).filter(it => it?.id?.videoId);
    console.log("[LearningResources] items with a valid videoId:", items.length);
    if (items.length === 0) {
      console.warn("[LearningResources] no video results for topic - returning empty result (not an error).");
      return respond(200, { topic, best: null, alternatives: [] });
    }

    const ids = items.map(it => it.id.videoId).join(",");
    const detailsUrl = "https://www.googleapis.com/youtube/v3/videos"
      + "?part=contentDetails,statistics&id=" + encodeURIComponent(ids)
      + "&key=" + encodeURIComponent(youtubeApiKey);
    console.log("[LearningResources] calling YouTube videos API for details on", items.length, "video(s)...");
    const detailsResp = await fetch(detailsUrl);
    const detailsData = await detailsResp.json().catch(() => ({}));
    console.log("[LearningResources] details API status:", detailsResp.status, "details returned:", (detailsData.items || []).length);
    if (!detailsResp.ok) {
      console.warn("[LearningResources] videos API failed, continuing with degraded (no duration/views) data:", detailsData?.error?.message || detailsData);
    }
    const detailsById = new Map((detailsData.items || []).map(d => [d.id, d]));

    const videos = items.map(it => {
      const id = it.id.videoId;
      const details = detailsById.get(id);
      const thumbs = buildThumbnailChain(id, it.snippet?.thumbnails);
      console.log("[LearningResources] thumbnail chain for", id, ":", thumbs);
      return {
        videoId: id,
        title: it.snippet?.title || "Untitled",
        channel: it.snippet?.channelTitle || "Unknown channel",
        thumbnail: thumbs[0] || "",
        thumbnails: thumbs,
        duration: details ? formatIsoDuration(details.contentDetails?.duration) : "",
        viewCount: details ? Number(details.statistics?.viewCount || 0) : 0,
        url: "https://www.youtube.com/watch?v=" + id
      };
    });
    console.log("[LearningResources] built", videos.length, "video objects. Ranking...");

    const ranked = rankVideos(videos);
    const best = ranked[0];
    const alternatives = ranked.slice(1, 4);
    console.log("[LearningResources] best video:", best?.videoId, best?.title);
    console.log("[LearningResources] alternatives:", alternatives.map(v => v.videoId));

    let why = "";
    try {
      why = await generateRecommendationReason(topic, best);
      console.log("[LearningResources] AI 'why' reason generated:", JSON.stringify(why));
    } catch (whyErr) {
      console.error("[LearningResources] failed to generate 'why' reason, continuing without it:", whyErr);
    }

    const responsePayload = {
      topic,
      best: { ...best, why },
      alternatives
    };
    console.log("[LearningResources] sending response to frontend:", JSON.stringify({
      topic: responsePayload.topic,
      bestVideoId: responsePayload.best?.videoId,
      alternativeCount: responsePayload.alternatives.length
    }));

    console.log("Preparing response");
    console.log("Sending response");
    respond(200, responsePayload);
    console.log("Response sent");
    return;
  } catch (e) {
    console.error("[LearningResources] unhandled error in YouTube pipeline:", e);
    return respond(500, { error: "Internal server error." });
  }
}

// ============================================
// HELPERS
// ============================================
// Builds the full maxres -> standard -> high -> medium -> default fallback chain of
// thumbnail URLs for a video. Prefers the URLs YouTube's search API already gave us
// (snippet.thumbnails), and fills in any missing tiers - or the whole chain, if the
// snippet had none - by constructing the well-known i.ytimg.com URL pattern directly
// from the videoId. This guarantees `thumbnails` is never empty just because one size
// was absent from the API response.
function buildThumbnailChain(videoId, snippetThumbnails) {
  const order = ["maxres", "standard", "high", "medium", "default"];
  const fallbackFile = {
    maxres: "maxresdefault.jpg",
    standard: "sddefault.jpg",
    high: "hqdefault.jpg",
    medium: "mqdefault.jpg",
    default: "default.jpg"
  };
  const chain = [];
  for (const size of order) {
    const url = snippetThumbnails?.[size]?.url
      || (videoId ? "https://i.ytimg.com/vi/" + videoId + "/" + fallbackFile[size] : "");
    if (url && !chain.includes(url)) chain.push(url);
  }
  return chain;
}

function getModelChain() {
  const base = (env.AI_API_BASE_URL || "").toLowerCase();
  if (base.includes("groq")) return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
  if (base.includes("openai")) return ["gpt-4o-mini", "gpt-3.5-turbo"];
  if (base.includes("nvidia")) return ACTIVE_MODELS; // meta/llama-3.1-70b-instruct (see DEFAULT_MODELS)
  return ACTIVE_MODELS;
}

function hasUsableChatCompletionPayload(respData) {
  if (!respData || typeof respData !== "object" || Array.isArray(respData)) return false;
  if (Object.keys(respData).length === 0) return false;
  const choices = Array.isArray(respData.choices) ? respData.choices : null;
  if (!choices || !choices.length) return false;
  const message = choices[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  return Boolean(content);
}

// Turns a raw provider HTTP status + error body (OpenRouter/OpenAI/Groq/Gemini all use
// roughly this {error:{message,type,code}} shape) into a short, human-readable reason,
// so logs and (in dev mode) the client response explain *why* the provider rejected
// the request instead of just repeating an opaque status code.
function explainProviderError(status, body) {
  const code = body?.error?.code || body?.error?.type || null;
  switch (status) {
    case 400: return "Provider rejected the request as malformed (bad schema/parameters), code: " + (code || "n/a");
    case 401: return "Provider rejected the API key as invalid or missing (authentication failure).";
    case 402: return "Provider account is out of quota/credits for this model.";
    case 403: return "Provider blocked the request (permissions or content policy), code: " + (code || "n/a");
    case 404: return "Provider does not recognize the requested model name.";
    case 408: return "Provider timed out generating a response.";
    case 429: return "Provider is rate-limiting this API key/model (too many requests).";
    case 500: return "Provider had an internal server error.";
    case 502: return "Provider's upstream gateway failed (bad gateway).";
    case 503: return "Provider is temporarily unavailable or overloaded.";
    default: return status ? ("Provider returned an unexpected HTTP " + status + ".") : "No response received from provider (network/timeout).";
  }
}

// Only these extensions are ever eligible to be served as static files.
// Anything not on this list (.env, .sql, .md, no extension, etc.) is refused.
const ALLOWED_STATIC_EXTENSIONS = new Set([".html", ".css", ".js", ".ico", ".png", ".svg", ".jpg", ".jpeg", ".webp"]);
// Specific filenames that must never be served even if their extension is allowed
// (e.g. server.js has a .js extension but must not be downloadable).
const BLOCKED_STATIC_NAMES = new Set(["server.js", "package.json", "package-lock.json", "supabase_schema.sql"]);

function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Malformed request path.");
    return;
  }

  // Reject dotfiles/dotdirs (.env, .git, ...) and node_modules anywhere in the path,
  // not just at the top level.
  const segments = decoded.split(/[\\/]/).filter(Boolean);
  if (segments.some(seg => seg.startsWith(".") || seg === "node_modules")) {
    res.writeHead(404); res.end("Not found"); return;
  }

  const target = resolve(join(root, decoded));
  // Must resolve to root itself or a genuine child of root - startsWith(root) alone
  // can be bypassed by a sibling directory that merely shares the prefix.
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext = extname(target).toLowerCase();
  const base = path.basename(target).toLowerCase();
  if (!ALLOWED_STATIC_EXTENSIONS.has(ext) || BLOCKED_STATIC_NAMES.has(base)) {
    res.writeHead(404); res.end("Not found"); return;
  }

  if (!existsSync(target) || statSync(target).isDirectory()) { res.writeHead(404); res.end("Not found"); return; }
  if (!ALLOWED_STATIC_EXTENSIONS.has(ext) || BLOCKED_STATIC_NAMES.has(base)) {
    res.writeHead(404); res.end("Not found"); return;
  }

  res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream", "cache-control": "public, max-age=0, no-cache" });
  createReadStream(target).pipe(res);
}

function loadEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => {
    const i = l.indexOf("="); if (i === -1) return [l, ""];
    let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return [l.slice(0, i).trim(), v];
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => {
      body += c;
      // Raised from 2MB to accommodate base64-encoded image attachments (a single
      // screenshot easily runs 2-4MB once base64-encoded); see IMAGE_* limits in
      // handleStudy for the actual per-image/per-request image caps.
      if (body.length > 16000000) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    throw new Error("Expected application/json request body.");
  }
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Malformed JSON.");
  }
}

function sendJson(res, status, data) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); }
function stripSlash(v) { return v.replace(/\/$/, ""); }
function cleanReply(value, escapeForHtml = true) {
  const sanitized = String(value)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\/?(?:tool_call|arg_key|arg_value)[^>]*>/gi, "")
    .replace(/`{1,3}\s*tool_code[\s\S]*?`{1,3}/gi, "")
    .trim();
  // HTML-escaping is only appropriate for replies that will later be inserted as
  // markup in the chat UI. noSave callers (e.g. the quiz generator) consume the raw
  // reply programmatically - JSON.parse-ing it - so escaping quotes/brackets to
  // &quot;/&amp;/etc. here would corrupt the JSON before the client ever sees it.
  if (!escapeForHtml) return sanitized;
  return sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function findIndexFile() {
  for (const name of ["study-app.html", "index.html", "app.html", "main.html"]) {
    const p = join(root, name); if (existsSync(p) && statSync(p).isFile()) return p;
  } return null;
}
