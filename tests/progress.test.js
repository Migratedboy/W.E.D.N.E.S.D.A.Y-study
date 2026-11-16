import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStudyProgress, quizXp, toDateKey } from "../lib/scheduling.js";

const empty = () => ({ globalStreak: 0, lastStudyDate: null, subjects: {}, totalXp: 0 });
const day = (s) => new Date(s + "T10:00:00.000Z");

test("the first study day starts a one-day streak and awards XP", () => {
  const { progress, xpAwarded } = applyStudyProgress(empty(), { subject: "Math", topic: "Algebra" }, day("2026-05-01"));
  assert.equal(progress.globalStreak, 1);
  assert.equal(progress.lastStudyDate, "2026-05-01");
  assert.equal(progress.subjects.Math.xp, 10);
  assert.equal(xpAwarded, 10 + 2); // base 10 + streak bonus (1 * 2)
  assert.equal(progress.totalXp, 12);
});

test("studying again the same day does not award XP twice", () => {
  const first = applyStudyProgress(empty(), { subject: "Math", topic: "Algebra" }, day("2026-05-01")).progress;
  const second = applyStudyProgress(first, { subject: "Math", topic: "Geometry" }, day("2026-05-01"));

  assert.equal(second.xpAwarded, 0, "no second daily award");
  assert.equal(second.progress.totalXp, 12, "total XP unchanged");
  assert.equal(second.progress.globalStreak, 1, "streak unchanged");
  assert.equal(second.progress.subjects.Math.xp, 10, "subject XP unchanged");
  assert.deepEqual(second.progress.subjects.Math.topicsCovered, ["Algebra", "Geometry"], "new topic still recorded");
});

test("consecutive days extend the streak and the bonus grows", () => {
  let progress = empty();
  let awarded = [];
  for (const d of ["2026-05-01", "2026-05-02", "2026-05-03"]) {
    const step = applyStudyProgress(progress, { subject: "Math", topic: "T" + d }, day(d));
    progress = step.progress;
    awarded.push(step.xpAwarded);
  }
  assert.equal(progress.globalStreak, 3);
  assert.deepEqual(awarded, [12, 14, 16]);
});

test("a missed day resets the streak to 1", () => {
  let progress = applyStudyProgress(empty(), { subject: "Math", topic: "a" }, day("2026-05-01")).progress;
  progress = applyStudyProgress(progress, { subject: "Math", topic: "b" }, day("2026-05-02")).progress;
  const afterGap = applyStudyProgress(progress, { subject: "Math", topic: "c" }, day("2026-05-09"));
  assert.equal(afterGap.progress.globalStreak, 1);
  assert.equal(afterGap.xpAwarded, 12);
});

test("the streak bonus is capped at +20", () => {
  let progress = empty();
  let last;
  for (let i = 1; i <= 15; i++) {
    const d = "2026-06-" + String(i).padStart(2, "0");
    last = applyStudyProgress(progress, { subject: "Science", topic: "x" }, day(d));
    progress = last.progress;
  }
  assert.equal(last.xpAwarded, 30, "10 base + 20 capped bonus");
});

test("applyStudyProgress does not mutate its input", () => {
  const original = empty();
  const snapshot = JSON.parse(JSON.stringify(original));
  applyStudyProgress(original, { subject: "Math", topic: "x" }, day("2026-05-01"));
  assert.deepEqual(original, snapshot);
});

test("topic history is de-duplicated per subject", () => {
  let progress = empty();
  progress = applyStudyProgress(progress, { subject: "Math", topic: "Algebra" }, day("2026-05-01")).progress;
  progress = applyStudyProgress(progress, { subject: "Math", topic: "Algebra" }, day("2026-05-02")).progress;
  assert.deepEqual(progress.subjects.Math.topicsCovered, ["Algebra"]);
});

// ---- quiz XP (the rules the client used to control) ----
test("quiz XP is five points per correct answer", () => {
  assert.equal(quizXp(0, 5), 0);
  assert.equal(quizXp(3, 5), 15);
});

test("a perfect score earns the 25-point bonus", () => {
  assert.equal(quizXp(5, 5), 50); // 25 + 25
});

test("a claimed score above the total is clamped, not trusted", () => {
  // This is the shape of the old forgery: {"correct":9999,"total":9999}
  assert.equal(quizXp(9999, 5), 50, "cannot exceed the real maximum");
  assert.equal(quizXp(5, 0), 0, "a zero-question quiz awards nothing");
});

test("negative or non-numeric input awards nothing", () => {
  assert.equal(quizXp(-3, 5), 0);
  assert.equal(quizXp("banana", 5), 0);
});

test("toDateKey uses local dates, padded", () => {
  assert.equal(toDateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(toDateKey(new Date(2026, 11, 31)), "2026-12-31");
});
