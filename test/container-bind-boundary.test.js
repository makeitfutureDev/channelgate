import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { assertSafeBindSource } = await import("../src/runtimes/container/lifecycle.js");
test("mount sources reject symlink leaves and parents without following them", () => {
  const root = tempDir("cg-bind-boundary-");
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep.json"), "sentinel");
  const link = path.join(root, "alias");
  symlinkSync(outside, link);
  assert.throws(() => assertSafeBindSource(link), /must be a real directory/);
  assert.throws(() => assertSafeBindSource(path.join(link, "new-child")), /must be a real directory/);
  assert.equal(readFileSync(path.join(outside, "keep.json"), "utf8"), "sentinel");
  assert.doesNotThrow(() => assertSafeBindSource(outside));
});
