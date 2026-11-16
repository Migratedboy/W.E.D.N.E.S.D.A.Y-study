import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewFlashcard } from "../lib/scheduling.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function card(overrides = {}) {
  return {
    repetitions: 0,
    interval: 1,
    ef: 2.5,
    correctCount: 0,
    incorrectCount: 0,
    ...overrides
  };
}

test("a new card answered 'good' is scheduled one day out", () => {
  const next = reviewFlashcard(card(), 4, NOW);
  assert.equal(next.repetitions, 1);
  assert.equal(next.interval, 1);
  assert.equal(next.correctCount, 1);
  assert.equal(next.incorrectCount, 0);
  assert.equal(next.nextReview, "2026-03-11T12:00:00.000Z");
});

test("the second successful review jumps to six days", () => {
  const next = reviewFlashcard(card({ repetitions: 1, interval: 1 }), 4, NOW);
  assert.equal(next.repetitions, 2);
  assert.equal(next.interval, 6);
});

test("later reviews multiply the interval by the easiness factor", () => {
  const next = reviewFlashcard(card({ repetitions: 2, interval: 6, ef: 2.5 }), 4, NOW);
  // interval 6 * ef 2.5 = 15. In SM-2, q=4 is EF-neutral (delta exactly 0).
  assert.equal(next.interval, 15);
  assert.equal(next.ef, 2.5);
});

test("a failed review resets the streak and counts the miss", () => {
  const next = reviewFlashcard(card({ repetitions: 4, interval: 30, ef: 2.4 }), 1, NOW);
  assert.equal(next.repetitions, 0);
  assert.equal(next.interval, 1);
  assert.equal(next.incorrectCount, 1);
  assert.equal(next.correctCount, 0);
});

test("the easiness factor never drops below the 1.3 floor", () => {
  let c = card();
  for (let i = 0; i < 40; i++) c = { ...c, ...reviewFlashcard(c, 3, NOW) };
  assert.equal(c.ef, 1.3);
});

test("booleans are accepted as a coarse quality signal", () => {
  const right = reviewFlashcard(card(), true, NOW);
  const wrong = reviewFlashcard(card(), false, NOW);
  assert.equal(right.repetitions, 1);
  assert.equal(wrong.repetitions, 0);
});

test("out-of-range quality is clamped instead of corrupting state", () => {
  // 99 clamps to the q=5 maximum, which is the one grade that raises EF (+0.1).
  const next = reviewFlashcard(card(), 99, NOW);
  assert.equal(next.ef, 2.6);
  assert.equal(next.repetitions, 1);

  const clampedNegative = reviewFlashcard(card(), -5, NOW);
  assert.equal(clampedNegative.repetitions, 0); // clamps to 0 -> treated as a miss
});

test("garbage quality falls back to 3 rather than NaN", () => {
  const next = reviewFlashcard(card(), "not-a-number", NOW);
  assert.ok(Number.isFinite(next.ef));
  assert.ok(Number.isFinite(next.interval));
});

test("the clock is injected, so scheduling is deterministic", () => {
  const a = reviewFlashcard(card(), 4, NOW);
  const b = reviewFlashcard(card(), 4, new Date("2026-03-10T12:00:00.000Z"));
  assert.deepEqual(a, b);
});
