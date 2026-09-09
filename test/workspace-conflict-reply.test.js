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
  test(`${conflict} conflict replies in the triggering thread without exposing private configuration`, async () => {
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
      await assert.rejects(assertWorkspaceSkillsCompatible(entry.slug, meta), { code: "workspace_selection_conflict" });
      await setUser("U_ALLOWED_CONFLICT", { approved: true });
      const posted = [];
      const client = {
        conversations: { info: async () => ({ channel: { name: channel, is_private: false } }) },
        chat: { postMessage: async message => { posted.push(message); return { ok: true }; } },
      };
      for (const text of ["<@UBOTCONFLICT> alive?", "<@UBOTCONFLICT> /mode"]) {
        const ts = String(100 + posted.length);
        const event = { type: "message", channel, channel_type: "channel", user: "U_ALLOWED_CONFLICT", text, ts,
          ...(posted.length ? { thread_ts: "99.1" } : {}) };
        await processMessageEvent(event, client, { botUserId: "UBOTCONFLICT", dedupeTrigger: true });
        await processMessageEvent(event, client, { botUserId: "UBOTCONFLICT", dedupeTrigger: true });
      }
      assert.equal(posted.length, 2);
      assert.deepEqual(posted.map(m => m.thread_ts), ["100", "99.1"]);
      for (const message of posted) {
        assert.equal(message.channel, channel);
        assert.match(message.text, /assign this folder to just one channel/);
        assert.match(message.text, /send your request again/);
        assert.ok(!message.text.includes(workDir));
        assert.ok(!message.text.includes("hidden-channel"));
      }
      await processMessageEvent({ type: "message", channel, channel_type: "channel", user: "U_DENIED_CONFLICT", text: "<@UBOTCONFLICT> alive?", ts: "200" }, client, { botUserId: "UBOTCONFLICT" });
      assert.equal(posted.length, 2);
      client.chat.postMessage = async () => { throw new Error("Slack delivery unavailable"); };
      await assert.doesNotReject(processMessageEvent({ type: "message", channel, channel_type: "channel", user: "U_ALLOWED_CONFLICT", text: "<@UBOTCONFLICT> alive?", ts: "201" }, client, { botUserId: "UBOTCONFLICT" }));
      assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    } finally {
      if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
      else process.env.CG_FS_ROOT = previousRoot;
    }
  });
}
