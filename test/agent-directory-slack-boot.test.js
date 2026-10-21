import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createSlackManager } = await import("../src/slack/manager.js");
const { createPlatformTransports } = await import("../src/platforms/boot.js");
const { liveConnector, resetTransports } = await import("../src/platforms/live.js");
const { automationTarget } = await import("../src/platforms/notify.js");
const { reconcileAgentDirectory, readAgentDirectoryMetadata } = await import("../src/gateway/agent-directory-refresh.js");
const { searchAgentDirectory } = await import("../src/gateway/agent-directory.js");
const { setUser, upsertChannelEntry, defaultChannelMeta, saveChannelMeta } = await import("../src/config/store.js");
const sourceId = "C_BOOT_SOURCE";
const specialistId = "C_BOOT_SPECIALIST";
const authorId = "U_BOOT_READER";

function webClient(purpose) {
  const calls = [];
  return { calls,
    chat: { postMessage: async () => ({ channel: sourceId, ts: "1.1" }), getPermalink: async () => ({ permalink: "https://slack.example/thread" }) },
    conversations: {
      info: async ({ channel }) => {
        calls.push(channel);
        return { ok: true, channel: { id: channel, name: channel === sourceId ? "boot-source" : "boot-specialist", is_channel: true, is_private: true, purpose: { value: purpose } } };
      },
      members: async () => ({ ok: true, members: [authorId, "U_BOOT_BOT"], response_metadata: {} }),
    },
  };
}

test("daemon transport boot exposes Slack discovery and follows disconnect/reconnect without changing native automation delivery", async () => {
  resetTransports();
  await setUser(authorId, { approved: true });
  for (const [channelId, name] of [[sourceId, "boot-source"], [specialistId, "boot-specialist"]]) {
    const entry = await upsertChannelEntry(channelId, { name, type: "group", isDM: false });
    await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId, name, type: "group", isDM: false }));
  }
  const first = webClient("Presentation specialist");
  const second = webClient("Updated presentation specialist");
  let next = first;
  const manager = createSlackManager({ start: async () => ({ app: { client: next, stop: async () => {} }, teamId: "T_BOOT", botUserId: "U_BOOT_BOT" }) });
  // This is the same boot entry the daemon calls, not an injected directory verifier/provider.
  createPlatformTransports({ slack: manager });
  const lookup = () => searchAgentDirectory({ createdBy: authorId, channelId: sourceId, limit: 50 });
  try {
    assert.equal(liveConnector("slack"), null);
    assert.equal((await lookup()).returned, 0);
    await manager.connect({});
    assert.equal(liveConnector("slack").client, first);
    assert.equal(automationTarget(manager, sourceId), first, "native Slack delivery keeps menus, images and getPermalink");
    const initial = await lookup();
    assert.deepEqual(initial.agents.map((entry) => entry.channelId).sort(), [sourceId, specialistId].sort());
    assert.equal(initial.agents.find((entry) => entry.channelId === specialistId).description, "Presentation specialist");
    assert.match(initial.agents[0].url, /^https:\/\/slack\.com\/app_redirect/);
    const refresh = await reconcileAgentDirectory();
    assert.equal(refresh.updated, 2);
    assert.equal(readAgentDirectoryMetadata()[specialistId].purpose, "Presentation specialist");
    await manager.disconnect();
    assert.equal(liveConnector("slack"), null);
    assert.equal(automationTarget(manager, sourceId), null);
    assert.equal((await lookup()).returned, 0, "cache never substitutes for disconnected live proof");
    const oldReads = first.calls.length;
    next = second;
    await manager.connect({});
    assert.equal(automationTarget(manager, sourceId), second);
    const updated = await lookup();
    assert.equal(updated.agents.find((entry) => entry.channelId === specialistId).description, "Updated presentation specialist");
    assert.equal(first.calls.length, oldReads, "old credentials/client are not retained by the registry");
  } finally {
    await manager.disconnect();
    resetTransports();
  }
});
