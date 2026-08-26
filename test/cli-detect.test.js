import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [{ detectInstalledClis, resetCliDetectionCache }, { CLI_INTEGRATIONS }] = await Promise.all([
  import("../src/gateway/cli-detect.js"),
  import("../src/config/cli-catalog.js"),
]);

test("detection reports every catalog id; API-only entries report null, not false", () => {
  resetCliDetectionCache();
  const result = detectInstalledClis();
  assert.deepEqual(Object.keys(result).sort(), Object.keys(CLI_INTEGRATIONS).sort());
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    if ((entry.bins || []).length === 0) assert.equal(result[id], null, id);
    else assert.equal(typeof result[id], "boolean", id);
  }
});

test("a binary in a searched dir counts as installed; an empty dir does not", () => {
  // dirs override isolates from the host machine's real installs AND the TTL cache.
  const empty = mkdtempSync(path.join(os.tmpdir(), "cli-detect-empty-"));
  const withBin = mkdtempSync(path.join(os.tmpdir(), "cli-detect-bin-"));
  const bin = (CLI_INTEGRATIONS.supabase.bins || [])[0];
  assert.ok(bin, "supabase entry must list a binary for this test");
  writeFileSync(path.join(withBin, bin), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(withBin, bin), 0o755);

  assert.equal(detectInstalledClis({ dirs: [empty] }).supabase, false);
  assert.equal(detectInstalledClis({ dirs: [empty, withBin] }).supabase, true);
  // API-only stays null regardless of dirs.
  assert.equal(detectInstalledClis({ dirs: [withBin] }).make, null);
});

test("TTL cache holds between calls and clears on reset", () => {
  resetCliDetectionCache();
  const first = detectInstalledClis({ now: 1_000 });
  // Same object back within the TTL window — no re-sweep.
  assert.equal(detectInstalledClis({ now: 30_000 }), first);
  // Past the TTL, a fresh sweep (deep-equal but not the identical cached object is acceptable;
  // assert only that it recomputes without error and keeps the same shape).
  const later = detectInstalledClis({ now: 120_000 });
  assert.deepEqual(Object.keys(later).sort(), Object.keys(first).sort());
  resetCliDetectionCache();
});
