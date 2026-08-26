import test from "node:test";
import assert from "node:assert/strict";
import { acquireKeyedLock, keyedLockCount } from "../src/util/keyed-lock.js";

test("keyed lock serializes one provider session but not unrelated sessions", async () => {
  const first = await acquireKeyedLock("codex", "same");
  let secondEntered = false;
  const secondPromise = acquireKeyedLock("codex", "same").then((release) => {
    secondEntered = true;
    return release;
  });
  const other = await acquireKeyedLock("codex", "other");
  assert.equal(secondEntered, false);
  other();
  first();
  const second = await secondPromise;
  assert.equal(secondEntered, true);
  second();
  await Promise.resolve();
  assert.equal(keyedLockCount(), 0);
});

test("a queued lock honors abort without blocking the next waiter", async () => {
  const first = await acquireKeyedLock("codex", "abortable");
  const controller = new AbortController();
  const aborted = acquireKeyedLock("codex", "abortable", { signal: controller.signal });
  const next = acquireKeyedLock("codex", "abortable");
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  first();
  const releaseNext = await next;
  releaseNext();
});

