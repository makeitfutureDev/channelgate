import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, setUser } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { assertWorkspaceSkillsCompatible } = await import("../src/gateway/skills/workspace-sync.js");

for (const conflict of ["skills", "memory"]) {
  test(`${conflict} differences automatically link to the existing setup without changing project files`, async () => {
    const root = tempDir("cg-conflict-reply-");
    const previousRoot = process.env.CG_FS_ROOT;
    process.env.CG_FS_ROOT = root;
    try {
      const workDir = path.join(root, "private-project");
      await mkdir(workDir);
      const sentinel = path.join(workDir, "untouched.txt");
      await writeFile(sentinel, "unchanged");
      const channel = `C_CONFLICT_${conflict}`;
      const entry = await upsertChannelEntry(channel, { name: channel, type: "channel", platform: "slack" });
      const meta = { ...defaultChannelMeta({ channelId: channel, name: channel, type: "channel", platform: "slack" }), workDir };
      await saveChannelMeta(entry.slug, meta);
      const other = await upsertChannelEntry(`${channel}_OTHER`, { name: "hidden-channel", type: "group", platform: "slack" });
      await saveChannelMeta(other.slug, { ...meta, channelId: `${channel}_OTHER`, ...(conflict === "memory" ? { memory: false } : { skills: ["different-skill"] }) });
      const { getChannelMeta } = await import("../src/config/store.js");
      const linked = await getChannelMeta(other.slug);
      assert.equal(linked.workspaceLink.slug, entry.slug);
      assert.deepEqual(linked.skills, meta.skills);
      assert.equal(linked.memory, meta.memory);
      await assert.doesNotReject(assertWorkspaceSkillsCompatible(entry.slug, meta));
      await assert.doesNotReject(assertWorkspaceSkillsCompatible(other.slug, linked));
      assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    } finally {
      if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
      else process.env.CG_FS_ROOT = previousRoot;
    }
  });
}
