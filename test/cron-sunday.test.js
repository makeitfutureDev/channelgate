import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronValid, cronMatches, nextCronRun, minIntervalMinutes } from "../src/util/cron.js";

// Use local constructors because the scheduler uses the daemon's wall clock.
const sunday = new Date(2026, 10, 8, 9, 0);
const saturday = new Date(2026, 10, 7, 9, 0);
const monday = new Date(2026, 10, 9, 9, 0);

test("Sunday 7 validates, matches Sunday only, and resolves the next weekly fire", () => {
  assert.equal(cronValid("0 9 * * 7"), true);
  assert.equal(cronMatches("0 9 * * 7", sunday), true);
  assert.equal(cronMatches("0 9 * * 7", saturday), false);
  assert.equal(cronMatches("0 9 * * 7", monday), false);
  assert.deepEqual(nextCronRun("0 9 * * 7", saturday), sunday);
  assert.deepEqual(nextCronRun("0 9 * * 7", sunday), new Date(2026, 10, 15, 9, 0));
  assert.equal(minIntervalMinutes("0 9 * * 7"), minIntervalMinutes("0 9 * * 0"));
});

test("Sunday normalization follows list/range expansion and step selection", () => {
  for (const [field, expected] of [
    ["0,7", [0]], ["1,7", [0, 1]], ["5-7", [0, 5, 6]],
    ["5-7/2", [0, 5]], ["0-7/2", [0, 2, 4, 6]],
    ["1-7/2", [0, 1, 3, 5]], ["6-7/2", [6]], ["7/2", [0]],
    ["*", [0, 1, 2, 3, 4, 5, 6]], ["*/2", [0, 2, 4, 6]],
    ["*/7", [0]],
  ]) {
    const expr = `0 9 * * ${field}`;
    assert.equal(cronValid(expr), true, expr);
    assert.deepEqual([...parseCron(expr)[4]].sort((a, b) => a - b), expected, expr);
    for (let day = 0; day < 7; day++) {
      assert.equal(cronMatches(expr, new Date(2026, 10, 8 + day, 9, 0)), expected.includes(day), expr);
    }
    const next = nextCronRun(expr, new Date(2026, 10, 7, 23, 59));
    assert.deepEqual(next, new Date(2026, 10, 8 + expected[0], 9, 0), expr);
  }
});

test("Sunday aliases preserve DOM/DOW OR and wildcard behavior", () => {
  for (const field of ["0", "7", "0,7"]) {
    assert.equal(cronMatches(`0 9 9 * ${field}`, sunday), true);
    assert.equal(cronMatches(`0 9 9 * ${field}`, monday), true);
    assert.equal(cronMatches(`0 9 9 * ${field}`, saturday), false);
    assert.deepEqual(nextCronRun(`0 9 9 * ${field}`, saturday), sunday);
  }
  assert.equal(cronMatches("0 9 9 * *", sunday), false);
  assert.equal(cronMatches("0 9 9 * *", monday), true);
  // An explicit full range remains restricted for the standard DOM/DOW OR rule.
  assert.equal(cronMatches("0 9 9 * 0-7", sunday), true);
  assert.equal(cronMatches("0 9 9 * */2", sunday), true);
});

test("Sunday alias does not admit out-of-range or reversed weekday fields", () => {
  for (const field of ["8", "6-8", "7-1", "8,0", "-1", "7-7/0"]) {
    const expr = `0 9 * * ${field}`;
    assert.equal(cronValid(expr), false, expr);
    assert.equal(cronMatches(expr, sunday), false, expr);
    assert.equal(nextCronRun(expr, saturday), null, expr);
  }
  assert.equal(cronValid("0 24 * * 7"), false);
});
