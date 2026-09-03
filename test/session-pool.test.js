// Unit tests for the warm-pool LRU eviction pick (M2). Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEvictions } from "../src/engines/session-pool.js";

const e = (key, idle, lastUsed) => ({ key, idle, lastUsed });

test("no evictions while under the cap", () => {
  assert.deepEqual(pickEvictions([e("a", true, 1), e("b", true, 2)], 8), []);
  assert.deepEqual(pickEvictions([], 8), []);
});

test("evicts the least-recently-used idle entry at the cap", () => {
  const entries = [e("old", true, 100), e("newer", true, 200), e("newest", true, 300)];
  assert.deepEqual(pickEvictions(entries, 3), ["old"]);
});

test("never picks busy entries, even if oldest", () => {
  const entries = [e("busy-old", false, 100), e("idle-new", true, 200), e("idle-mid", true, 150)];
  assert.deepEqual(pickEvictions(entries, 3), ["idle-mid"]);
});

test("all busy → no evictions (pool briefly overflows instead of killing turns)", () => {
  const entries = [e("a", false, 1), e("b", false, 2)];
  assert.deepEqual(pickEvictions(entries, 2), []);
});

test("evicts several when well over the cap, oldest first", () => {
  const entries = [e("a", true, 3), e("b", true, 1), e("c", true, 2), e("d", false, 0)];
  assert.deepEqual(pickEvictions(entries, 3), ["b", "c"]);
});
