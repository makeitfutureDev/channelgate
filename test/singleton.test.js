import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireSingletonLock } from "../src/util/singleton.js";

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "cg-singleton-"));
}

test("singleton lock refuses another live gateway process", () => {
  const root = tempRoot();
  try {
    writeFileSync(path.join(root, "gateway.lock"), JSON.stringify({ pid: process.pid, token: "other" }) + "\n");

    assert.throws(() => acquireSingletonLock(root), /already running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("singleton lock replaces a stale pid lock and releases only its own file", () => {
  const root = tempRoot();
  try {
    const lockFile = path.join(root, "gateway.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: 99999999, token: "stale" }) + "\n");

    const lock = acquireSingletonLock(root);
    assert.equal(existsSync(lockFile), true);
    const content = JSON.parse(String(readFileSync(lockFile)));
    assert.equal(content.pid, process.pid);

    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
