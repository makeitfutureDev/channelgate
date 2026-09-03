// The enforcement point itself: src/gateway/run.js admits every turn through licenseAdmission()
// before the folder is provisioned, the session is minted, or an engine is spawned.
//
// The contract a refusal has to meet is behavioural, not cosmetic: no run starts, nothing is
// billed, and the caller gets a DELIVERABLE result. Every origin's delivery path posts
// `result.content`, so returning the notice there is what makes a refused scheduled or background
// turn announce itself instead of dying quietly (AGENTS.md: "silence that looks like death is the
// bug this exists to prevent").
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, testLicenseEnv, testLicensePublicKeyPem } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { resetLicenseUsage, conversationUsage } = await import("../src/ee/limits.js");
const { resetLicenseAnnouncements } = await import("../src/ee/license.js");

async function dm(id, name) {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "claude", cleanMode: true, allowNetwork: false,
  });
  return entry;
}

function unlicensed() {
  resetLicenseUsage();
  resetLicenseAnnouncements();
  saveSettings({ licenseKey: "", engine: "claude", codexFallback: false, composioMode: "personal" });
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  clearTestLicense();
}

test("without a key the second conversation is refused with the notice and no run starts", async () => {
  unlicensed();
  await setUser("U_LIC", { name: "Lic", approved: true, isAdmin: false });
  await dm("D_LIC_ONE", "lic-one");
  await dm("D_LIC_TWO", "lic-two");

  const first = await runMessage({
    channelId: "D_LIC_ONE", authorId: "U_LIC", text: "hello", threadKey: "1900.100",
    origin: "slack_foreground", preferCold: true,
  });
  assert.equal(first.licenseRefused, undefined, "the allowed conversation runs normally");
  assert.match(first.content, /Stub engine reply/i);

  const second = await runMessage({
    channelId: "D_LIC_TWO", authorId: "U_LIC", text: "hello", threadKey: "1900.101",
    origin: "slack_foreground", preferCold: true,
  });
  assert.equal(second.licenseRefused, true);
  assert.equal(second.licenseReason, "conversation_limit");
  assert.match(second.content, /limited to 1 conversation without a license key/);
  // Deliverable, not an error: content is what every origin's delivery path posts, and the
  // accounting fields are zeroed so a refusal can never be billed.
  assert.equal(second.costUSD, 0);
  assert.equal(second.durationMs, 0);
  assert.equal(second.sessionId, null);
  assert.equal(second.cwd, "", "no folder was provisioned for a turn that never ran");

  // Nothing was charged to the refused conversation.
  const rows = conversationUsage();
  assert.equal(rows.find((r) => r.conversationId === "D_LIC_TWO").runs, 0);
});

test("a refused scheduled turn produces the same deliverable notice", async () => {
  unlicensed();
  await setUser("U_LIC_S", { name: "LicS", approved: true, isAdmin: false });
  await dm("D_LIC_S_ONE", "lic-s-one");
  await dm("D_LIC_S_TWO", "lic-s-two");
  await runMessage({ channelId: "D_LIC_S_ONE", authorId: "U_LIC_S", text: "hi", threadKey: "1900.200", origin: "slack_foreground", preferCold: true });

  const scheduled = await runMessage({
    channelId: "D_LIC_S_TWO", authorId: "U_LIC_S", text: "the daily digest", threadKey: "sched-1",
    origin: "schedule", preferCold: true,
  });
  // deliverResult() posts result.content for schedule/diagnosis/recovery, so the operator sees
  // exactly why the scheduled run produced nothing.
  assert.equal(scheduled.licenseRefused, true);
  assert.ok(scheduled.content.trim().length > 0, "a daemon-origin refusal is never an empty answer");
  assert.match(scheduled.content, /license key/);
});

test("a licensed deployment admits every conversation and prefixes no notice", async () => {
  resetLicenseUsage();
  resetLicenseAnnouncements();
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  testLicenseEnv({ tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } });
  saveSettings({ licenseKey: "", engine: "claude", codexFallback: false, composioMode: "personal" });

  await setUser("U_LIC_E", { name: "LicE", approved: true, isAdmin: false });
  for (const [id, name, thread] of [["D_LIC_E1", "lic-e1", "1900.300"], ["D_LIC_E2", "lic-e2", "1900.301"]]) {
    await dm(id, name);
    const result = await runMessage({ channelId: id, authorId: "U_LIC_E", text: "hello", threadKey: thread, origin: "slack_foreground", preferCold: true });
    assert.equal(result.licenseRefused, undefined);
    assert.doesNotMatch(result.content, /license key/i);
  }
});
