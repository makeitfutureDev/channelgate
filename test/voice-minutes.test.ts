import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const settings = await import("../src/config/settings.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const minutes = await import("../src/gateway/voice/voice-minutes.ts");

beforeEach(() => {
  getDb().exec(`DELETE FROM events WHERE event IN ('${minutes.USAGE_EVENT}', '${minutes.LIMIT_EVENT}')`);
  minutes.setLiveChatgptUsageSource(() => []);
});
after(() => { settings.saveSettings({ voiceCallsEnabled: false, voiceChatgptEnabled: false, voiceChatgptAllowanceMinutes: 0 }); });

const MIN = 60_000;

test("the meter sums this sign-in's calls over the rolling 5 hours, adds live calls and splits out the caller's share", async () => {
  await minutes.recordChatgptCallUsage({ callId: "c1", login: "codex", ownerId: "U_A", audioMs: 4 * MIN, connectedMs: 9 * MIN });
  await minutes.recordChatgptCallUsage({ callId: "c2", login: "codex", ownerId: "U_B", audioMs: 0, connectedMs: 3 * MIN });
  await minutes.recordChatgptCallUsage({ callId: "c3", login: "codex-lic-0a1b2c3d", ownerId: "U_A", audioMs: 10 * MIN, connectedMs: 10 * MIN });
  minutes.setLiveChatgptUsageSource(() => [{ login: "codex", ownerId: "U_A", usedMs: 2 * MIN }, { login: "codex-lic-0a1b2c3d", ownerId: "U_B", usedMs: MIN }]);
  const meter = minutes.chatgptVoiceMeter({ login: "codex", ownerId: "U_A", allowanceMinutes: 30 });
  assert.equal(meter.usedMs, 9 * MIN, "OpenAI's audio time when reported (4), else connected time (3), plus the live call (2)");
  assert.equal(meter.ownUsedMs, 6 * MIN);
  assert.equal(meter.calls, 3);
  assert.equal(meter.weekMs, 9 * MIN);
  assert.equal(meter.allowanceMs, 30 * MIN);
  assert.equal(meter.remainingMs, 21 * MIN);
  assert.equal(meter.limit, null);
  assert.equal(minutes.describeVoiceMeter(meter, { own: true }), "9 min used in the last 5 hours (6 min by you) · about 21 min left of 30 min");
  // Another sign-in is metered separately; an unknown allowance shows only what was used.
  const other = minutes.chatgptVoiceMeter({ login: "codex-lic-0a1b2c3d" });
  assert.equal(other.usedMs, 11 * MIN); assert.equal(other.remainingMs, null);
  assert.equal(minutes.describeVoiceMeter(other), "11 min used in the last 5 hours");
  // Six hours later the calls have left the 5-hour window but still count for the week.
  minutes.setLiveChatgptUsageSource(() => []);
  const later = minutes.chatgptVoiceMeter({ login: "codex", now: Date.now() + 6 * 60 * MIN });
  assert.equal(later.usedMs, 0); assert.equal(later.weekMs, 7 * MIN); assert.equal(later.calls, 0);
  assert.equal(minutes.chatgptVoiceMeter({ login: "codex", now: Date.now() + 8 * 24 * 60 * MIN }).weekMs, 0);
  assert.equal(minutes.chatgptVoiceMeter({ login: "codex", allowanceMinutes: 5 }).remainingMs, 0, "never below zero");
  assert.equal(minutes.chatgptVoiceMeter({ login: "codex", allowanceMinutes: 99_999 }).allowanceMs, 24 * 60 * MIN, "clamped to a day");
});

test("an allowance status from OpenAI is remembered until it renews", async () => {
  const now = Date.now();
  await minutes.recordChatgptLimit({ login: "codex", ownerId: "U_A", status: "exceeded", resetSeconds: 600 }, undefined, () => now);
  await minutes.recordChatgptLimit({ login: "codex-lic-0a1b2c3d", ownerId: "U_A", status: "exceeded", resetSeconds: 600 }, undefined, () => now);
  const meter = minutes.chatgptVoiceMeter({ login: "codex", allowanceMinutes: 30, now });
  assert.deepEqual(meter.limit, { status: "exceeded", resetAt: now + 600_000 });
  assert.equal(minutes.describeVoiceMeter(meter, { now }), "0 min used in the last 5 hours · allowance used up — renews in about 10 min");
  assert.equal(minutes.chatgptVoiceMeter({ login: "codex", now: now + 601_000 }).limit, null, "gone once the reset time passed");
});

test("the allowance estimate is an admin setting: a whole number of minutes, 0 meaning unknown", async (t) => {
  const app = express(); app.use(express.json());
  app.use("/admin", createSettingsRouter({ slack: { snapshot: () => ({ connected: false }) } } as never));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const put = (patch: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/admin/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...patch, connectSlack: false }) });
  assert.equal((await put({ voiceChatgptAllowanceMinutes: 30 })).status, 200);
  assert.equal(settings.getVoiceCallConfig().chatgpt.allowanceMinutes, 30);
  for (const bad of [-1, 1.5, "30", 1441]) assert.equal((await put({ voiceChatgptAllowanceMinutes: bad })).status, 400, String(bad));
  assert.equal(settings.getVoiceCallConfig().chatgpt.allowanceMinutes, 30, "a refused value changes nothing");
  assert.equal((await put({ voiceChatgptAllowanceMinutes: 0 })).status, 200);
  assert.equal(settings.getVoiceCallConfig().chatgpt.allowanceMinutes, 0);
  settings.saveSettings({ voiceCallsEnabled: true, voiceChatgptEnabled: true, voiceChatgptAllowanceMinutes: 20 });
  await minutes.recordChatgptCallUsage({ callId: "c9", login: "codex", ownerId: "U_A", audioMs: 5 * MIN, connectedMs: 5 * MIN });
  const view = settings.voiceMinutesView({ ownerId: "U_A" });
  assert.equal(view?.text, "5 min used in the last 5 hours (5 min by you) · about 15 min left of 20 min");
  const listed = settings.settingsForApi() as { voiceCalls: { chatgpt: { allowanceMinutes: number; meter: { usedMs: number; text: string } } } };
  assert.equal(listed.voiceCalls.chatgpt.allowanceMinutes, 20);
  assert.equal(listed.voiceCalls.chatgpt.meter.usedMs, 5 * MIN, "the admin card gets the whole sign-in's use");
  assert.equal(listed.voiceCalls.chatgpt.meter.text, "5 min used in the last 5 hours · about 15 min left of 20 min");
});
