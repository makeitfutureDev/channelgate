// Unit tests for the rolling-tail buffer cap. Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTail } from "../src/util/tail.js";

test("appends normally under the cap", () => {
  assert.equal(appendTail("", "abc", 10), "abc");
  assert.equal(appendTail("abc", "def", 10), "abcdef");
});

test("keeps only the last max characters once over the cap", () => {
  assert.equal(appendTail("abcdef", "ghij", 6), "efghij");
  assert.equal(appendTail("", "0123456789", 4), "6789");
});

test("a huge single chunk is clipped to its own tail", () => {
  const big = "x".repeat(1000) + "END";
  const out = appendTail("prefix", big, 5);
  assert.equal(out, "xxEND");
});

test("exact fit is untouched", () => {
  assert.equal(appendTail("ab", "cd", 4), "abcd");
});
