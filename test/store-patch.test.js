// Atomic config patches (M4): patchChannelMeta merges only the supplied keys inside a write
// transaction, and saveSettings merges settings.json the same way. Runs against a throwaway
// gateway dir + SQLite file — the env is set BEFORE the store module is imported so getDb()
// opens the scratch DB, never the real ~/.claude-gateway one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const dir = ensureTestEnv();

const { saveChannelMeta, getChannelMeta, patchChannelMeta, defaultChannelMeta, getUser, setUser } = await import("../src/config/store.js");
const { getProgressView, saveSettings, settingsForApi, getDmTemplates } = await import("../src/config/settings.js");

test("patchChannelMeta merges only the supplied keys", async () => {
  await saveChannelMeta("chan-a", { adminMode: false, allowBash: false, skills: ["a"] });
  const next = await patchChannelMeta("chan-a", { allowBash: true });
  assert.equal(next.allowBash, true);
  assert.equal(next.adminMode, false); // untouched key survives
  assert.deepEqual(next.skills, ["a"]);
  assert.deepEqual(await getChannelMeta("chan-a"), next);
});

test("patchChannelMeta: two writers patching different keys both persist", async () => {
  await saveChannelMeta("chan-b", { adminMode: false, allowBash: false, nudges: false });
  await patchChannelMeta("chan-b", { adminMode: true });
  await patchChannelMeta("chan-b", { nudges: true });
  const meta = await getChannelMeta("chan-b");
  assert.equal(meta.adminMode, true); // NOT clobbered by the second patch
  assert.equal(meta.nudges, true);
  assert.equal(meta.allowBash, false);
});

test("patchChannelMeta function form derives the partial from the current record", async () => {
  await saveChannelMeta("chan-c", { allowedMcps: [{ name: "one" }] });
  const next = await patchChannelMeta("chan-c", (cur) => ({ allowedMcps: [...cur.allowedMcps, { name: "two" }] }));
  assert.deepEqual(next.allowedMcps.map((m) => m.name), ["one", "two"]);
});

test("channel and DM-template defaults preserve a separate Codex MCP selection", () => {
  const channel = defaultChannelMeta({ channelId: "C1", name: "one", type: "channel", isDM: false });
  assert.deepEqual(channel.allowedMcps, []);
  assert.deepEqual(channel.allowedCodexMcps, []);

  const templates = getDmTemplates();
  assert.deepEqual(templates.user.allowedCodexMcps, []);
  assert.deepEqual(templates.admin.allowedCodexMcps, []);
});

test("patchChannelMeta function returning null writes nothing", async () => {
  const res = await patchChannelMeta("chan-missing", (cur) => (cur ? { allowBash: true } : null));
  assert.equal(res, null);
  assert.equal(await getChannelMeta("chan-missing"), null);
});

test("setUser transaction merges field-scoped patches without clearing omitted values", async () => {
  await setUser("U_PATCH", { name: "Ada", approved: true, composioToken: "kept" });
  await setUser("U_PATCH", { approved: false, composioToken: undefined });
  assert.deepEqual(await getUser("U_PATCH"), {
    name: "Ada",
    approved: false,
    isAdmin: false,
    composioToken: "kept",
    skillsToken: "",
    toolboxToken: "",
    skills: [],
    allowedMcps: [],
    allowedCodexMcps: [],
    allowedOpenCodeMcps: [],
  });
});

test("saveSettings merges only supplied keys and skips undefined", () => {
  saveSettings({ engine: "claude", contextWindow: 200000 });
  saveSettings({ engine: "codex", contextWindow: undefined });
  const stored = JSON.parse(readFileSync(path.join(dir, "config", "settings.json"), "utf8"));
  assert.equal(stored.engine, "codex");
  assert.equal(stored.contextWindow, 200000); // undefined means "leave as-is"
});

test("legacy progressView settings are ignored in favor of native streaming", () => {
  saveSettings({ progressView: "log" });
  const stored = JSON.parse(readFileSync(path.join(dir, "config", "settings.json"), "utf8"));
  assert.equal(stored.progressView, "log"); // legacy value may remain on disk
  assert.equal(getProgressView(), "stream");
  assert.equal(settingsForApi().progressView, "stream");
});
