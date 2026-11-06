import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const root = fileURLToPath(new URL("..", import.meta.url));
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${path.join(root, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelsIndex } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { licenseAdmission, resetLicenseUsage, usageTotals, conversationUsage } = await import("../src/ee/limits.js");
const { getDb } = await import("../src/db/index.js");

test("foreground turn admission enforces 100 threads independently in two registered Free channels", async () => {
  resetLicenseUsage();
  saveSettings({ licenseKey: "", engine: "claude", codexFallback: false, composioMode: "personal" });
  testLicenseEnv({ tier: "free" });
  await setUser("U_FREE_THREADS", { approved: true, isAdmin: false });
  for (const channelId of ["C_FREE_A", "C_FREE_B"]) {
    const entry = await upsertChannelEntry(channelId, { name: channelId, type: "channel", isDM: false });
    await saveChannelMeta(entry.slug, { channelId, name: channelId, template: "custom", engine: "claude", cleanMode: true, allowNetwork: false });
    // Seed proven admitted thread identities in this registered channel. The actual final slot,
    // over-cap refusal, retry and second channel are exercised through the real orchestrator.
    for (let i = 1; i <= 99; i++) assert.equal(licenseAdmission({ conversationId: channelId, threadKey: `thread-${i}` }).allowed, true);
    const run = threadKey => runMessage({ channelId, authorId: "U_FREE_THREADS", text: "Reply with admission healthy", threadKey, origin: "slack_foreground", preferCold: true });
    const hundredth = await run("thread-100");
    assert.equal(hundredth.licenseRefused, undefined);
    assert.match(hundredth.content, /Stub engine reply/i);
    const refused = await run("thread-101");
    assert.equal(refused.licenseRefused, true);
    assert.equal(refused.licenseReason, "channel_conversation_limit");
    assert.match(refused.content, /100 active conversation threads/);
    assert.equal(refused.sessionId, null);
    assert.equal(refused.cwd, "");
    assert.equal(refused.costUSD, 0);
    assert.equal(refused.durationMs, 0);
    assert.equal((await run("thread-100")).licenseRefused, undefined);
    assert.equal(conversationUsage().find(r => r.conversationId === channelId).activeConversations, 100);
    assert.equal(conversationUsage().find(r => r.conversationId === channelId).runs, 101);
  }
  assert.equal(Object.keys(await getChannelsIndex()).length, 2);
  assert.equal(usageTotals().activeConversations, 200);
  assert.equal(usageTotals().runs, 202);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM sessions WHERE thread_key='thread-101'").get().n, 0);
});
