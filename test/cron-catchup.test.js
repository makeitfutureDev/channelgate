// M7: scheduler minute catch-up. elapsedMinutes enumerates the minute boundaries a drifted tick
// skipped, so a "0 9 * * *" cron still fires when ticks land at 08:59:58 and 09:01:02.
import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsedMinutes, cronMatches } from "../src/util/cron.js";

const MIN = 60_000;
const t = (h, m, s = 0) => new Date(2026, 5, 15, h, m, s).getTime(); // local time, arbitrary day
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN;

test("first tick (no previous) evaluates only the current minute", () => {
  const now = t(9, 0, 30);
  assert.deepEqual(elapsedMinutes(0, now), [minuteOf(now)]);
  assert.deepEqual(elapsedMinutes(NaN, now), [minuteOf(now)]);
});

test("normal cadence yields exactly the one new minute", () => {
  const prev = t(8, 59, 58);
  const now = t(9, 0, 58);
  assert.deepEqual(elapsedMinutes(prev, now), [t(9, 0)]);
});

test("a drifted tick catches the skipped minute (08:59:58 -> 09:01:02 includes 09:00)", () => {
  const prev = t(8, 59, 58);
  const now = t(9, 1, 2);
  const minutes = elapsedMinutes(prev, now);
  assert.deepEqual(minutes, [t(9, 0), t(9, 1)]);
  // …and the daily-9am cron matches the recovered minute.
  assert.equal(cronMatches("0 9 * * *", new Date(minutes[0])), true);
});

test("two ticks inside the same minute do not re-evaluate it (double-fire guard)", () => {
  const prev = t(9, 0, 5);
  const now = t(9, 0, 40);
  assert.deepEqual(elapsedMinutes(prev, now), []);
});

test("never re-includes the previous tick's own minute", () => {
  const prev = t(9, 0, 59);
  const now = t(9, 1, 1);
  assert.deepEqual(elapsedMinutes(prev, now), [t(9, 1)]);
});

test("a long pause is capped to the most recent maxMinutes", () => {
  const prev = t(3, 0);
  const now = t(9, 0, 10); // six hours later (sleep/suspend)
  const minutes = elapsedMinutes(prev, now, 5);
  assert.equal(minutes.length, 5);
  assert.deepEqual(minutes, [t(8, 56), t(8, 57), t(8, 58), t(8, 59), t(9, 0)]);
});

test("minutes come back oldest-first and contiguous", () => {
  const prev = t(9, 0, 10);
  const now = t(9, 3, 30);
  const minutes = elapsedMinutes(prev, now);
  assert.deepEqual(minutes, [t(9, 1), t(9, 2), t(9, 3)]);
});
