// Recall by injection, proven at the run boundary: a FRESH session's prompt carries the channel's
// memory snapshot in front of the message; the resumed follow-up turn does not repeat it; a clean
// thread never sees it. Uses the prompt-echo `claude` stub, whose "answer" is the prompt it got.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "snapshot-workspaces");

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { applyMemoryOperations } = await import("../src/gateway/channel-memory.js");
const { setThreadClean } = await import("../src/gateway/thread-engine.js");

async function channel(id, name) {
  await setUser("U_SNAPSHOT", { name: "Snapshot User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const meta = { channelId: id, name, type: "channel", template: "custom", engine: "claude", cleanMode: false, allowNetwork: false, memory: true };
  await saveChannelMeta(entry.slug, meta);
  const cwd = effectiveWorkDir(entry.slug, meta);
  await mkdir(cwd, { recursive: true });
  return { entry, meta, cwd };
}

test("a fresh session gets the memory snapshot in front of its message; the resumed turn does not", async () => {
  saveSettings({ engine: "claude", agentMemory: true, memoryReviewEvery: 0, composioMode: "personal" });
  const { entry, meta, cwd } = await channel("C_SNAPSHOT_RUN", "snapshot-run");
  await applyMemoryOperations(cwd, meta, [{ action: "add", text: "Reports go out on Fridays.", section: "Decisions" }]);

  const first = await runMessage({ channelId: "C_SNAPSHOT_RUN", authorId: "U_SNAPSHOT", text: "when do reports go out?", threadKey: "8000.001", origin: "slack_foreground", preferCold: true });
  assert.match(first.content, /^\[Channel memory — snapshot at session start; index \d+% of its 8000-char budget/);
  assert.match(first.content, /Reports go out on Fridays\./);
  assert.match(first.content, /\[End of channel memory\.\]\n\nwhen do reports go out\?$/);

  const second = await runMessage({ channelId: "C_SNAPSHOT_RUN", authorId: "U_SNAPSHOT", text: "and the second one?", threadKey: "8000.001", origin: "slack_foreground", preferCold: true });
  assert.doesNotMatch(second.content, /Channel memory/, "a resumed session already carries the snapshot in its history");
  assert.equal(second.content, "and the second one?");
});

test("an empty index and a clean thread inject nothing", async () => {
  saveSettings({ engine: "claude", agentMemory: true, memoryReviewEvery: 0, composioMode: "personal" });
  const { entry } = await channel("C_SNAPSHOT_EMPTY", "snapshot-empty");
  const r = await runMessage({ channelId: "C_SNAPSHOT_EMPTY", authorId: "U_SNAPSHOT", text: "hello there friend", threadKey: "8000.002", origin: "slack_foreground", preferCold: true });
  assert.equal(r.content, "hello there friend");

  const { meta: m2, cwd: cwd2 } = await channel("C_SNAPSHOT_CLEAN", "snapshot-clean");
  await applyMemoryOperations(cwd2, m2, [{ action: "add", text: "Reports go out on Fridays." }]);
  const cleanEntry = await upsertChannelEntry("C_SNAPSHOT_CLEAN", { name: "snapshot-clean", type: "channel" });
  await setThreadClean(cleanEntry.slug, "8000.003", true);
  const clean = await runMessage({ channelId: "C_SNAPSHOT_CLEAN", authorId: "U_SNAPSHOT", text: "clean question here", threadKey: "8000.003", origin: "slack_foreground", preferCold: true });
  assert.equal(clean.content, "clean question here", "clean mode = memory off = no snapshot");
  void entry;
});
