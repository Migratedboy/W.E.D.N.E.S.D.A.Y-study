// ============================================================
// Scheduling math
// ============================================================
// Pure functions only - no I/O, no globals. Extracted from server.js so the
// rules can be unit-tested directly (see tests/sm2.test.js).

/**
 * SM-2 spaced-repetition step.
 *
 * @param {object} card            current card state
 * @param {number} card.repetitions
 * @param {number} card.interval    days
 * @param {number} card.ef          easiness factor
 * @param {number} card.correctCount
 * @param {number} card.incorrectCount
 * @param {number|boolean} quality  0-5 (SM-2); booleans map to 5/1
 * @param {Date} [now]              injectable clock
 * @returns {object} the updated card fields
 */
export function reviewFlashcard(card, quality, now = new Date()) {
  let q = typeof quality === "boolean" ? (quality ? 5 : 1) : Number(quality);
  if (Number.isNaN(q)) q = 3;
  q = Math.max(0, Math.min(5, q));

  const next = {
    repetitions: Number(card.repetitions) || 0,
    interval: Number(card.interval) || 1,
    ef: Number(card.ef) || 2.5,
    correctCount: Number(card.correctCount) || 0,
    incorrectCount: Number(card.incorrectCount) || 0
  };

  if (q < 3) {
    next.repetitions = 0; // reset progress if the student struggled
    next.incorrectCount += 1;
    next.interval = 1;
  } else {
    next.correctCount += 1;
    if (next.repetitions === 0) next.interval = 1;
    else if (next.repetitions === 1) next.interval = 6;
    else next.interval = Math.round(next.interval * next.ef);
    next.repetitions += 1;
  }

  // Easiness factor drift. Never drops below 1.3 (SM-2 floor).
  next.ef = next.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (next.ef < 1.3) next.ef = 1.3;

  const nextDate = new Date(now.getTime());
  nextDate.setDate(nextDate.getDate() + (next.interval || 1));
  next.nextReview = nextDate.toISOString();
  next.lastReviewed = now.toISOString();

  return next;
}

/**
 * Streak + XP bookkeeping for a study event.
 * Returns the progress object to persist plus how much XP was awarded.
 */
export function applyStudyProgress(progressData, { subject, topic }, now = new Date()) {
  const progress = {
    globalStreak: Number(progressData.globalStreak) || 0,
    lastStudyDate: progressData.lastStudyDate || null,
    subjects: { ...(progressData.subjects || {}) },
    totalXp: Number(progressData.totalXp) || 0
  };

  const today = toDateKey(now);
  const yesterday = toDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const wasNewDayOverall = progress.lastStudyDate !== today;

  if (!progress.subjects[subject]) {
    progress.subjects[subject] = { topicsCovered: [], studyDays: [], xp: 0 };
  }
  const subj = progress.subjects[subject];
  subj.topicsCovered = Array.isArray(subj.topicsCovered) ? subj.topicsCovered : [];
  subj.studyDays = Array.isArray(subj.studyDays) ? subj.studyDays : [];
  subj.xp = Number(subj.xp) || 0;

  if (topic && !subj.topicsCovered.includes(topic)) {
    subj.topicsCovered.push(topic);
  }

  if (!subj.studyDays.includes(today)) {
    subj.studyDays.push(today);
    subj.xp += 10;
  }

  if (progress.lastStudyDate === today) {
    // already studied today
  } else if (progress.lastStudyDate === yesterday) {
    progress.globalStreak += 1;
  } else {
    progress.globalStreak = 1;
  }
  progress.lastStudyDate = today;

  let xpAwarded = 0;
  if (wasNewDayOverall) {
    const streakBonus = Math.min(progress.globalStreak, 10) * 2; // caps at +20
    xpAwarded = 10 + streakBonus;
    progress.totalXp += xpAwarded;
  }

  return { progress, xpAwarded };
}

/**
 * XP for a graded quiz. Points per correct answer plus a perfect-score bonus.
 */
export function quizXp(correct, total) {
  const c = Math.max(0, Math.min(Number(correct) || 0, Number(total) || 0));
  const t = Math.max(0, Number(total) || 0);
  const perfectBonus = t > 0 && c === t ? 25 : 0;
  return c * 5 + perfectBonus;
}

/** Local (not UTC) YYYY-MM-DD, so "today" matches the user's day. */
export function toDateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
