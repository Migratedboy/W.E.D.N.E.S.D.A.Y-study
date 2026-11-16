// ============================================================
// Model-output parsing
// ============================================================
// Pure helpers that turn messy LLM text into structured data.

/**
 * Extract the first balanced JSON array from a model reply, tolerating prose,
 * code fences and trailing commentary.
 */
export function extractJsonArray(raw) {
  const s = String(raw || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = s.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1).replace(/,(\s*[}\]])/g, "$1"));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Normalize model output into the exact question shape stored and graded
 * against: 2-6 options plus an in-range integer correctIndex.
 */
export function normalizeQuizQuestions(parsed, max = 8) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((q) => q && typeof q.question === "string" && q.question.trim() && Array.isArray(q.options))
    .map((q) => {
      const options = q.options
        .filter((o) => typeof o === "string" && o.trim())
        .map((o) => o.trim())
        .slice(0, 6);
      return {
        question: q.question.trim().slice(0, 500),
        options,
        correctIndex: Number(q.correctIndex),
        explanation: typeof q.explanation === "string" ? q.explanation.trim().slice(0, 300) : ""
      };
    })
    .filter(
      (q) =>
        q.options.length >= 2 &&
        Number.isInteger(q.correctIndex) &&
        q.correctIndex >= 0 &&
        q.correctIndex < q.options.length
    )
    .slice(0, max);
}

/**
 * Grade submitted answers against a stored answer key.
 * Anything missing or out of range counts as wrong.
 */
export function gradeQuiz(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  const given = Array.isArray(answers) ? answers : [];
  const correct = list.reduce(
    (sum, q, i) => (Number(given[i]) === Number(q.correctIndex) ? sum + 1 : sum),
    0
  );
  return { correct, total: list.length };
}

/**
 * Strip tool-call debris and (optionally) HTML-escape a model reply.
 * Callers that parse the reply as JSON must pass escapeForHtml: false.
 */
export function cleanReply(value, escapeForHtml = true) {
  const sanitized = String(value)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\/?(?:tool_call|arg_key|arg_value)[^>]*>/gi, "")
    .replace(/`{1,3}\s*tool_code[\s\S]*?`{1,3}/gi, "")
    .trim();
  if (!escapeForHtml) return sanitized;
  return sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "PT14M32S" -> "14:32", "PT1H2M3S" -> "1:02:03". */
export function formatIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ""));
  if (!m) return "";
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const mm = h > 0 ? String(min).padStart(2, "0") : String(min);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

/** Blend search rank with (log-scaled) popularity. */
export function rankVideos(videos) {
  const list = Array.isArray(videos) ? videos : [];
  const maxViews = Math.max(1, ...list.map((v) => v.viewCount || 0));
  return list
    .map((v, i) => {
      const relevance = 1 - i / list.length; // 1.0 (first) -> ~0 (last)
      const popularity = Math.log10((v.viewCount || 0) + 1) / Math.log10(maxViews + 1);
      return { ...v, score: relevance * 0.6 + popularity * 0.4 };
    })
    .sort((a, b) => b.score - a.score);
}

/** Rough token estimate used for telemetry and history budgeting. */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/**
 * Drop oldest history turns until the total character budget is respected.
 * The most recent turn is always kept, even if it alone exceeds the budget.
 */
export function truncateHistoryToBudget(history, charBudget = 12000) {
  const list = Array.isArray(history) ? history : [];
  let truncatedCount = 0;
  let used = 0;
  const kept = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const len = String(list[i]?.content ?? "").length;
    if (used + len > charBudget && kept.length > 0) {
      truncatedCount = i + 1;
      break;
    }
    used += len;
    kept.unshift(list[i]);
  }
  return { history: kept, truncatedCount, chars: used };
}

/**
 * Response timeout that scales with the requested output size:
 * a short chat reply fails fast, a 3000-token quiz gets real headroom.
 */
export function computeRequestTimeoutMs(maxTokens, opts = {}) {
  const base = opts.base ?? 20000;
  const perToken = opts.perToken ?? 30;
  const floor = opts.floor ?? 30000;
  const ceiling = opts.ceiling ?? 120000;
  const tokens = Number(maxTokens) || 0;
  const scaled = base + tokens * perToken;
  return Math.max(floor, Math.min(ceiling, scaled));
}
