import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { dbFile } = await import("../src/config/paths.js");
const { saveCallHistory, listCallHistory, readCallHistory } = await import("../src/gateway/voice/history.js");

test("call receipts survive another process and hide costs outside the licensed history window", () => {
  testLicenseEnv({ tier: "free" });
  getDb().exec("DELETE FROM voice_calls");
  const recent = { id: "recent", ownerId: "U_MINE", teamId: "T_WORK", startedMs: Date.now(), endedMs: Date.now(), durationMs: 42500,
    costUSD: 0.1234, model: "gemini-3.8-live", summary: "A useful discussion", reason: "hangup", threads: [] };
  saveCallHistory(recent);
  saveCallHistory({ ...recent, id: "old", startedMs: 1, endedMs: 42501 });
  assert.equal(readCallHistory("old", "U_MINE", "T_WORK").costUSD, null);
  assert.equal(listCallHistory("U_MINE", "T_WORK").calls.find((row) => row.id === "old").costUSD, null);
  assert.equal(readCallHistory("recent", "U_MINE", "T_WORK").costUSD, 0.1234);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(JSON.stringify(db.prepare('SELECT duration_ms, summary FROM voice_calls WHERE id=?').get('recent'))); db.close();`, dbFile()], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { duration_ms: 42500, summary: "A useful discussion" });
});
