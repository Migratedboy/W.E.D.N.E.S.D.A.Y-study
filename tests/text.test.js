import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonArray,
  normalizeQuizQuestions,
  gradeQuiz,
  cleanReply,
  truncateHistoryToBudget,
  formatIsoDuration,
  rankVideos,
  computeRequestTimeoutMs
} from "../lib/text.js";

const validQuizJson = JSON.stringify([
  { question: "2+2?", options: ["3", "4", "5", "6"], correctIndex: 1, explanation: "basic sum" },
  { question: "Capital of France?", options: ["Paris", "Rome"], correctIndex: 0, explanation: "obvious" }
]);

// ---- extractJsonArray ----
test("parses a bare JSON array", () => {
  assert.equal(extractJsonArray(validQuizJson).length, 2);
});

test("survives code fences and surrounding prose", () => {
  const raw = 'Sure! Here you go:\n```json\n' + validQuizJson + '\n```\nHope that helps!';
  assert.equal(extractJsonArray(raw).length, 2);
});

test("tolerates trailing commas", () => {
  const raw = '[{"question":"a","options":["x","y"],"correctIndex":0,},]';
  assert.equal(extractJsonArray(raw).length, 1);
});

test("returns null when there is no array", () => {
  assert.equal(extractJsonArray("no json here"), null);
  assert.equal(extractJsonArray(""), null);
  assert.equal(extractJsonArray(null), null);
});

test("returns null on truncated JSON instead of throwing", () => {
  assert.equal(extractJsonArray('[{"question":"a","options":["x","y"]'), null);
});

test("brackets inside strings do not confuse the scanner", () => {
  const raw = '[{"question":"what is [x]?","options":["[a]","[b]"],"correctIndex":1}]';
  const parsed = extractJsonArray(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].options[0], "[a]");
});

// ---- normalizeQuizQuestions: this is the trust boundary ----
test("keeps well-formed questions", () => {
  const qs = normalizeQuizQuestions(extractJsonArray(validQuizJson));
  assert.equal(qs.length, 2);
  assert.equal(qs[0].correctIndex, 1);
});

test("drops questions whose correctIndex is out of range", () => {
  const qs = normalizeQuizQuestions([
    { question: "a", options: ["x", "y"], correctIndex: 5 },
    { question: "b", options: ["x", "y"], correctIndex: -1 },
    { question: "c", options: ["x", "y"], correctIndex: 1 }
  ]);
  assert.deepEqual(qs.map((q) => q.question), ["c"]);
});

test("drops questions with fewer than two options", () => {
  const qs = normalizeQuizQuestions([{ question: "a", options: ["only"], correctIndex: 0 }]);
  assert.equal(qs.length, 0);
});

test("caps at eight questions", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ question: "q" + i, options: ["a", "b"], correctIndex: 0 }));
  assert.equal(normalizeQuizQuestions(many).length, 8);
});

test("rejects non-array input", () => {
  assert.deepEqual(normalizeQuizQuestions(null), []);
  assert.deepEqual(normalizeQuizQuestions({}), []);
});

// ---- gradeQuiz ----
const key = [
  { question: "q1", options: ["a", "b"], correctIndex: 1 },
  { question: "q2", options: ["a", "b"], correctIndex: 0 },
  { question: "q3", options: ["a", "b"], correctIndex: 1 }
];

test("grades a perfect run", () => {
  assert.deepEqual(gradeQuiz(key, [1, 0, 1]), { correct: 3, total: 3 });
});

test("grades a mixed run", () => {
  assert.deepEqual(gradeQuiz(key, [1, 1, -1]), { correct: 1, total: 3 });
});

test("missing answers count as wrong, not as errors", () => {
  assert.deepEqual(gradeQuiz(key, []), { correct: 0, total: 3 });
  assert.deepEqual(gradeQuiz(key, undefined), { correct: 0, total: 3 });
});

test("claimed answers beyond the key are ignored", () => {
  // A client sending 99 answers for a 3-question quiz can still only score 3.
  assert.deepEqual(gradeQuiz(key, [1, 0, 1, 1, 1, 1]), { correct: 3, total: 3 });
});

test("string answers are coerced", () => {
  assert.deepEqual(gradeQuiz(key, ["1", "0", "1"]), { correct: 3, total: 3 });
});

test("an empty quiz grades to zero of zero", () => {
  assert.deepEqual(gradeQuiz([], [0]), { correct: 0, total: 0 });
});

// ---- cleanReply ----
test("strips script and tool-call debris from model output", () => {
  const dirty = 'Answer<script>alert(1)</script> here<tool_call>{"x":1}</tool_call>';
  assert.equal(cleanReply(dirty), "Answer here");
});

test("escapes HTML when the reply is rendered as markup", () => {
  assert.equal(cleanReply('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("does not escape when the caller parses JSON", () => {
  const json = '{"a":"<b>"}';
  assert.equal(cleanReply(json, false), json);
});

// ---- truncateHistoryToBudget ----
test("short histories pass through untouched", () => {
  const history = [{ role: "user", content: "hi" }];
  const out = truncateHistoryToBudget(history, 100);
  assert.equal(out.history.length, 1);
  assert.equal(out.truncatedCount, 0);
});

test("oldest turns are dropped first", () => {
  const history = [
    { role: "user", content: "a".repeat(50) },
    { role: "assistant", content: "b".repeat(50) },
    { role: "user", content: "c".repeat(50) }
  ];
  const out = truncateHistoryToBudget(history, 60);
  assert.deepEqual(out.history.map((m) => m.content[0]), ["c"]);
  assert.equal(out.truncatedCount, 2);
});

test("the most recent turn is kept even if it alone exceeds the budget", () => {
  const history = [{ role: "user", content: "x".repeat(500) }];
  const out = truncateHistoryToBudget(history, 10);
  assert.equal(out.history.length, 1);
  assert.equal(out.truncatedCount, 0);
});

// ---- misc ----
test("ISO durations format as clock times", () => {
  assert.equal(formatIsoDuration("PT14M32S"), "14:32");
  assert.equal(formatIsoDuration("PT1H2M3S"), "1:02:03");
  assert.equal(formatIsoDuration("bogus"), "");
});

test("video ranking prefers relevant, popular results", () => {
  const ranked = rankVideos([
    { title: "first", viewCount: 10 },
    { title: "second", viewCount: 1000000 }
  ]);
  assert.equal(ranked.length, 2);
  assert.ok(ranked[0].score >= ranked[1].score);
});

test("request timeouts scale with output size and stay clamped", () => {
  const small = computeRequestTimeoutMs(200);
  const large = computeRequestTimeoutMs(3000);
  assert.ok(large > small);
  assert.ok(small >= 30000);
  assert.ok(computeRequestTimeoutMs(999999) <= 120000);
});
