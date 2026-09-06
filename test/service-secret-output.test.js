// Real orchestration and job delivery with disposable CLIs. Only fake credentials are echoed.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const fakeKeys = {
  ANTHROPIC_API_KEY: "fake-output-anthropic-api-value",
  ANTHROPIC_AUTH_TOKEN: "fake-output-anthropic-auth-value",
  OPENAI_API_KEY: "fake-output-openai-api-value",
  CODEX_API_KEY: "fake-output-codex-api-value",
};
Object.assign(process.env, fakeKeys);
const channelSecret = "fake-output-channel-owned-value";
const values = [...Object.values(fakeKeys), channelSecret];
const bin = tempDir("cg-output-fixture-");
for (const engine of ["claude", "codex"]) {
  const target = path.join(bin, engine);
  await copyFile(new URL("./fixtures/output-secret-engine.cjs", import.meta.url), target);
  await chmod(target, 0o700);
}
const fixtureBin = fileURLToPath(new URL("./fixtures/", import.meta.url));
process.env.PATH = [bin, fixtureBin, process.env.PATH || ""].join(path.delimiter);
process.env.SESSION_KEEPALIVE = "0";
const { useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { BackgroundJobs } = await import("../src/gateway/background.js");
const { getDb, fromJson } = await import("../src/db/index.js");

async function configure(engine = "claude", fallback = true) {
  resetEngineCooldowns();
  saveSettings({ engine, engineFallback: fallback, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_OUTPUT", { approved: true, name: "Output Fixture" });
  const entry = await upsertChannelEntry("D_OUTPUT", { name: "output-fixture", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: "D_OUTPUT", type: "im", isDM: true, template: "custom", engine, cleanMode: false, autoMode: true, allowNetwork: false, env: { OUTPUT_TEST_TOKEN: { provider: "local", value: channelSecret } } });
  return entry;
}
function assertSafe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of values) assert.equal(text.includes(secret), false, "a fake credential reached an output surface");
  assert.match(text, /\[REDACTED\]/);
}
const run = (text, options = {}) => runMessage({ channelId: "D_OUTPUT", authorId: "U_OUTPUT", text, threadKey: text, origin: "slack_foreground", preferCold: true, ...options });

test("service and channel secrets are redacted from primary replies, split deltas and tool/notice events", async () => {
  await configure();
  const deltas = [], events = [];
  const result = await run("OUTPUT_FIXTURE_PRIMARY", { onDelta: (text) => deltas.push(text), onEvent: (event) => events.push(event) });
  assert.equal(result.engine, "claude");
  assert.match(result.content, /Visible prefix.*visible suffix\./);
  assertSafe(result);
  assertSafe(deltas.join(""));
  assertSafe(events);
  assert.ok(events.some((event) => event.kind === "tool_use" && event.target.includes("[REDACTED]")));
  assert.equal(deltas.join(""), result.content);
});

test("fallback replies redact service and channel secrets in both final and streamed content", async () => {
  await configure();
  const deltas = [];
  const result = await run("OUTPUT_FIXTURE_FALLBACK", { onDelta: (text) => deltas.push(text) });
  assert.equal(result.engine, "codex");
  assert.equal(result.fellBack, true);
  assertSafe(result);
  assertSafe(deltas.join(""));
});

for (const engine of ["claude", "codex"]) {
  test(engine + " failure messages and diagnostic details redact echoed service credentials", async () => {
    await configure(engine, false);
    await assert.rejects(run("OUTPUT_FIXTURE_ERROR_" + engine), (error) => {
      assertSafe({ message: error.message, stack: error.stack, details: error.details });
      return true;
    });
  });
}

test("background shell spawns omit service keys and redact detached log tails before truncation", async () => {
  const entry = await configure();
  const jobs = new BackgroundJobs({ resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta), requestShellApproval: async () => ({ allow: true }) });
  await mkdir(path.join(process.env.CG_WORKSPACE_DIR, "slack", entry.slug), { recursive: true });
  const started = await jobs.start({ channelId: "D_OUTPUT", authorId: "U_OUTPUT", threadKey: "shell-output", command: "printf '%s' \"$OUTPUT_TEST_TOKEN\"", label: "Output fixture" });
  assert.equal(started.ok, true, started.error);
  const spec = backend.calls.spawn.findLast((call) => call.kind === "job");
  assert.ok(spec);
  for (const name of Object.keys(fakeKeys)) assert.equal(Object.hasOwn(spec.env, name), false, name + " is an engine credential");
  assert.equal(spec.env.OUTPUT_TEST_TOKEN, channelSecret);
  const deadline = Date.now() + 12_000;
  while (jobs.count() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(jobs.count(), 0);
  assertSafe(jobs.status(started.id).tail);
  const logFile = path.join(bin, "recovered-job.log");
  await writeFile(logFile, Object.values(fakeKeys).join("\n") + channelSecret + "x".repeat(5_985));
  const tail = await jobs._tailFromLog(logFile, { runtimeChild: {}, secretValues: values });
  assertSafe(tail);
  assert.equal(tail.includes(channelSecret.slice(-10)), false, "truncation cannot expose a secret suffix");
});

test("background completion persists redacted outcomes and reports, and redelivery sanitizes old checkpoints", async () => {
  getDb().prepare("DELETE FROM bg_jobs").run();
  const jobs = new BackgroundJobs();
  const rec = { id: "output-pending", kind: "agent", channelId: "D_OUTPUT", threadKey: "pending-output", label: "Output fixture", startedAt: Date.now(), secretValues: values, result: { content: values.join(" / ") } };
  jobs.jobs.set(rec.id, rec);
  await jobs._finish(rec, { outcome: { ok: false, kind: "failed", summary: "Fixture failure " + values.join(" / ") } });
  const persisted = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id).data);
  assertSafe(persisted.pendingDelivery);
  const notices = [], delivered = [];
  jobs._client = () => ({ platform: "slack", post: async (payload) => notices.push(payload) });
  jobs.deliver = async (_client, { result }) => { delivered.push(result); throw new Error("Delivery fixture " + fakeKeys.OPENAI_API_KEY); };
  rec.pendingDelivery = { outcome: { ok: false, kind: "failed", summary: fakeKeys.ANTHROPIC_AUTH_TOKEN }, continuationResult: { content: channelSecret + fakeKeys.CODEX_API_KEY } };
  await jobs._deliver(rec);
  assertSafe(delivered);
  assertSafe(notices);
  const retry = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id).data);
  assertSafe(retry.pendingDelivery);
});
