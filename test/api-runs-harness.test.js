// HTTP callers can select the same separate harnesses as chat, with the legacy engine alias.
// Exercise admission plus the real route/driver/registry seam using only CLI fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import express from "express";
import { ensureTestEnv, clearTestLicense } from "./helpers.js";

const scratch = ensureTestEnv();
const root = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(root, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-harness-workspaces");

const { upsertChannelEntry, saveChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { ENGINE_IDS } = await import("../src/engines/registry.js");
const { channelCodexHome } = await import("../src/gateway/channel-codex-auth.js");
const { startApiRun, getApiJob, stopApiRun } = await import("../src/gateway/api-runs.js");
const { createRunsRouter } = await import("../src/web/routes/runs.js");
const { setRuntimeResolver } = await import("../src/gateway/run.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

let sequence = 0;
async function fixture({ connected = false, approvedEngines = null } = {}) {
  saveSettings({ engine: "claude", engineEnabled: Object.fromEntries(ENGINE_IDS.map(id => [id, true])), engineFallback: false, memoryReviewEvery: 0, composioMode: "personal" });
  const channelId = `C_API_HARNESS_${++sequence}`;
  const entry = await upsertChannelEntry(channelId, { name: `api-harness-${sequence}`, type: "channel" });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "channel", platform: "slack", template: "custom", engine: "claude", allowedMcps: [], ...(connected ? { codexAuthSource: "channel" } : {}) });
  if (connected) {
    const home = channelCodexHome(channelId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "test-channel-refresh-token" } }), { mode: 0o600 });
  }
  if (approvedEngines) await patchChannelMeta(entry.slug, { approvedEngines });
  return { channelId, entry };
}
const noEngine = job => { job.status = "completed"; };
test.afterEach(() => setRuntimeResolver(null));

test("harness aliases engine and preserves existing callers and per-run pinning", async () => {
  const f = await fixture({ connected: true });
  for (const fields of [{ harness: "codex-channel" }, { engine: "codex-channel" }, { engine: " CODEX-CHANNEL ", harness: "codex-channel" }, { engine: "codex" }]) {
    const started = await startApiRun({ message: "Review changes", channel: f.channelId, ...fields, driver: noEngine });
    assert.equal(started.ok, true, started.error);
    const expected = fields.harness || fields.engine;
    assert.equal(started.harness, expected);
    assert.equal(started.engine, expected);
    assert.equal(getApiJob(started.jobId).overrides.engine, expected, "the selected harness reaches the ordinary per-run pin");
  }
});

test("invalid or conflicting harness names are refused before reserving a job", async () => {
  const f = await fixture();
  let started = 0;
  for (const fields of [{ harness: "missing" }, { engine: "codex", harness: "codex-channel" }]) {
    const result = await startApiRun({ message: "Review changes", channel: f.channelId, ...fields, driver: () => { started++; } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 400);
    assert.match(result.error, /harness/);
  }
  assert.equal(started, 0);
});

test("channel-account API selection requires the target's account and harness approval", async () => {
  // Connecting one conversation never makes its account selectable from a different target.
  await fixture({ connected: true });
  const unconnected = await fixture();
  let started = 0;
  const missing = await startApiRun({ message: "Review changes", channel: unconnected.channelId, harness: "codex-channel", driver: () => { started++; } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /channel account|connect|sign.in|configured/i);

  const restricted = await fixture({ connected: true, approvedEngines: ["claude"] });
  const refused = await startApiRun({ message: "Review changes", channel: restricted.channelId, harness: "codex-channel", driver: () => { started++; } });
  assert.equal(refused.code, 403);
  assert.match(refused.error, /not an approved harness/);
  assert.equal(started, 0);
});

test("disabled and unlicensed channel-account API requests start no job", async () => {
  const f = await fixture({ connected: true });
  let started = 0;
  const input = { message: "Review changes", channel: f.channelId, harness: "codex-channel", driver: () => { started++; } };
  saveSettings({ engineEnabled: { "codex-channel": false } });
  const disabled = await startApiRun(input);
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /disabled/);
  saveSettings({ engineEnabled: { "codex-channel": true } });
  clearTestLicense();
  try {
    const unlicensed = await startApiRun(input);
    assert.equal(unlicensed.ok, false);
    assert.match(unlicensed.error, /Enterprise/);
    assert.equal(started, 0);
  } finally { ensureTestEnv(); }
});

test("a running API job reports the resolved default-failover harness before completion", async () => {
  const f = await fixture();
  saveSettings({ engineFallback: true });
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));
  const started = await startApiRun({ channel: f.channelId, message: "CLAUDE_STUB_LIMIT_FAIL_SAFE CODEX_STUB_WAIT_FOR_CANCEL" });
  assert.equal(started.harness, "claude", "admission starts from the channel default");
  try {
    const deadline = Date.now() + 10_000;
    while (!backend.calls.spawn.some(call => call.cmd === "codex")) {
      assert.ok(Date.now() < deadline, getApiJob(started.jobId)?.error || "fallback did not start");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const running = getApiJob(started.jobId);
    assert.equal(running.status, "running");
    assert.equal(running.engine, "codex", "status/list harness aliases now reflect the actual live runtime");
  } finally {
    stopApiRun(started.jobId);
    const deadline = Date.now() + 5_000;
    while (["running", "queued"].includes(getApiJob(started.jobId)?.status)) {
      assert.ok(Date.now() < deadline, "the stopped fixture settles");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
});

test("POST, idempotent retries and GET detail/list identify the actual channel Codex harness", async () => {
  const f = await fixture({ connected: true });
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));
  const app = express();
  app.use("/api/runs", createRunsRouter());
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/runs`;
  const post = body => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const input = { message: "Review changes", channel: f.channelId, harness: "codex-channel", idempotencyKey: "api-channel-harness-event" };
    const response = await post(input);
    assert.equal(response.status, 202);
    const first = await response.json();
    assert.equal(first.harness, "codex-channel");
    assert.equal(first.engine, first.harness);
    const deadline = Date.now() + 15_000;
    while (["running", "queued"].includes(getApiJob(first.jobId)?.status)) {
      assert.ok(Date.now() < deadline, "the fixture run settles");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const detail = await (await fetch(`${base}/${first.jobId}`)).json();
    assert.equal(detail.status, "completed", detail.error);
    assert.match(detail.result, /Codex stub reply/);
    assert.equal(detail.harness, "codex-channel", "completion preserves the separate account harness identity");
    const listing = await (await fetch(base)).json();
    const listed = listing.jobs.find(job => job.jobId === first.jobId);
    assert.equal(listed.harness, detail.harness);
    assert.equal(listed.engine, detail.harness);
    const retry = await post({ ...input, harness: "claude" });
    assert.equal(retry.status, 200);
    const duplicate = await retry.json();
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.harness, "codex-channel", "an event retry reports the original job rather than switching its harness");
    assert.equal(duplicate.reused, true);
    const conflicting = await post({ message: "Review changes", channel: f.channelId, engine: "codex", harness: "codex-channel" });
    assert.equal(conflicting.status, 400);
    assert.equal(backend.calls.spawn.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
