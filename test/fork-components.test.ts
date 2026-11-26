import assert from "node:assert/strict";
import test from "node:test";
import { ensureTestEnv } from "./helpers.js";
import { ForkBatch } from "../src/gateway/fork-batch.ts";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { getThreadClean, getThreadEffort, getThreadEngine, getThreadLicensePool, getThreadModel, setThreadRuntimeOverrides } =
  await import("../src/gateway/thread-engine.js");
const { resolveForkSettings } = await import("../src/gateway/fork-settings.ts");

test("a stop arriving during the per-child access check cancels this and subsequent roots", async () => {
  const forks = ["one", "two"].map(title => ({ title, prompt: title }));
  const snapshots: string[][] = [];
  const batch = new ForkBatch(forks, rows => snapshots.push(rows.map(row => row.status)));
  let stopped = false;
  let checks = 0;
  await batch.start({
    stopped: () => stopped,
    authorize: async () => { checks++; stopped = true; },
    create: async () => assert.fail("a stopped batch cannot create a remote thread"),
  });
  await batch.waitForCopies();
  assert.equal(checks, 1);
  assert.deepEqual(snapshots, [["cancelled", "pending"], ["cancelled", "cancelled"]]);
});

test("fork settings initialize the child's whole runtime and clean posture in one transaction", async () => {
  const slug = "fork-components", source = "source", child = "child";
  const fields = { engine: "claude", model: "opus", effort: "high", clean: true, licensePool: "any" } as const;
  setThreadRuntimeOverrides(slug, source, fields);
  const settings = await resolveForkSettings({ slug, threadKey: source, engine: "claude", meta: {} });
  assert.deepEqual(settings, fields);
  const readChild = () => Promise.all([getThreadEngine(slug, child), getThreadModel(slug, child),
    getThreadEffort(slug, child), getThreadLicensePool(slug, child), getThreadClean(slug, child)]);
  const db = getDb();
  db.exec("CREATE TEMP TRIGGER refuse_fork_clean BEFORE INSERT ON thread_overrides WHEN NEW.kind = 'clean' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  try {
    assert.throws(() => setThreadRuntimeOverrides(slug, child, settings), /fixture failure/);
    assert.deepEqual(await readChild(), ["", "", "", "", false]);
  } finally { db.exec("DROP TRIGGER refuse_fork_clean"); }
  setThreadRuntimeOverrides(slug, child, settings);
  assert.deepEqual(await readChild(), ["claude", "opus", "high", "any", true]);
  setThreadRuntimeOverrides(slug, child, { engine: "claude" });
  assert.equal(await getThreadClean(slug, child), true, "ordinary settings edits preserve the child's clean posture");
});
