import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "credential-workspaces");
const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");
const { useFakeRuntime } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
const { setUser, upsertChannelEntry, saveChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");

const fixtureValue = "synthetic-credential-discovery-value-ONLY";
const entry = (value = fixtureValue) => ({ provider: "local", value });
const prefix = "[Channel credentials for THIS attempt]";
const promptOf = (call) => call.args.find((arg) => String(arg).includes("[Gateway runtime for THIS attempt:"));
const attempts = (start) => backend.calls.spawn.slice(start).filter(promptOf);
function namesOf(prompt) {
  const match = prompt.match(/^Available channel environment variable names: (\[[^\n]*\])\.$/m);
  assert.ok(match, "inventory must be a names-only JSON array");
  assert.equal(prompt.split(prefix).length - 1, 1);
  return JSON.parse(match[1]);
}

test("credential discovery lists only sorted, usable names without values or suffixes", () => {
  const prompt = channelCredentialsPreamble({
    Z_SERVICE_TOKEN: fixtureValue, A_SERVICE_TOKEN: "another-synthetic-value-ZYXW",
    EMPTY_TOKEN: "", OBJECT_TOKEN: { value: fixtureValue }, PATH: fixtureValue,
    CG_PRIVATE_TOKEN: fixtureValue, "BAD\nINSTRUCTION": fixtureValue,
  });
  assert.deepEqual(namesOf(prompt), ["A_SERVICE_TOKEN", "Z_SERVICE_TOKEN"]);
  for (const forbidden of [fixtureValue, "ONLY", "ZYXW", "EMPTY_TOKEN", "OBJECT_TOKEN", "CG_PRIVATE_TOKEN", "BAD\nINSTRUCTION"]) {
    assert.ok(!prompt.includes(forbidden), `must omit ${forbidden}`);
  }
  assert.match(prompt, /replaces earlier turns/);
  assert.match(prompt, /never silently substitute a channel credential for a personal connection/);
});

test("empty inventory clears old assumptions, while clean mode suppresses discovery", () => {
  assert.deepEqual(namesOf(channelCredentialsPreamble()), []);
  assert.match(channelCredentialsPreamble(), /not that all CLI logins or MCP connections are absent/);
  assert.equal(channelCredentialsPreamble({ QA_SERVICE_TOKEN: fixtureValue }, { clean: true }), "");
});

async function fixture(name, engine, extra = {}) {
  saveSettings({ engine, defaultClaudeModel: "sonnet", defaultCodexModel: "gpt-5.6-sol", engineFallback: true,
    engineEnabled: { claude: true, codex: true }, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal" });
  const authorId = `U_${name}`;
  const channelId = `C_${name}`;
  await setUser(authorId, { name: "Credential fixture", approved: true });
  const channel = await upsertChannelEntry(channelId, { name: name.toLowerCase(), type: "channel" });
  await saveChannelMeta(channel.slug, { channelId, type: "channel", engine, memory: false,
    cleanMode: false, allowNetwork: false, env: { QA_SERVICE_TOKEN: entry() }, ...extra });
  return { channel, channelId, authorId, threadKey: `${name}.1`, origin: "slack_foreground", preferCold: true };
}

for (const engine of ["claude", "codex"]) {
  test(`${engine}: fresh and resumed prompts track actual injected credentials through rotation, addition and removal`, async () => {
    const ctx = await fixture(`CREDENTIALS_${engine}`, engine);
    const start = backend.calls.spawn.length;
    await runMessage({ ...ctx, text: "Read the QA service status." });
    const rotated = "rotated-synthetic-credential-discovery-ONLY";
    await patchChannelMeta(ctx.channel.slug, { env: { QA_SERVICE_TOKEN: entry(rotated), QA_OTHER_TOKEN: entry() } });
    await runMessage({ ...ctx, text: "Check again." });
    await patchChannelMeta(ctx.channel.slug, { env: {} });
    await runMessage({ ...ctx, text: "What access remains?" });
    const calls = attempts(start);
    assert.equal(calls.length, 3);
    const expected = [["QA_SERVICE_TOKEN"], ["QA_OTHER_TOKEN", "QA_SERVICE_TOKEN"], []];
    for (let i = 0; i < calls.length; i++) {
      const prompt = promptOf(calls[i]);
      assert.deepEqual(namesOf(prompt), expected[i]);
      assert.deepEqual(Object.keys(calls[i].env).filter((name) => name.startsWith("QA_")).sort(), expected[i]);
      assert.ok(!prompt.includes(fixtureValue));
      assert.ok(!prompt.includes(rotated));
      assert.match(prompt, new RegExp(`"session":"${i === 0 ? "fresh" : "resumed"}"`));
    }
    assert.equal(calls[1].env.QA_SERVICE_TOKEN, rotated);
  });

  test(`${engine}: clean mode and another channel cannot advertise or inherit the fixture credential`, async () => {
    const ctx = await fixture(`CREDENTIALS_CLEAN_${engine}`, engine, { cleanMode: true });
    const start = backend.calls.spawn.length;
    await runMessage({ ...ctx, text: "Which credentials are available?" });
    const [clean] = attempts(start);
    assert.ok(!promptOf(clean).includes(prefix));
    assert.ok(!promptOf(clean).includes("QA_SERVICE_TOKEN"));
    assert.equal(clean.env.QA_SERVICE_TOKEN, undefined);
    const other = await fixture(`CREDENTIALS_OTHER_${engine}`, engine, { env: {} });
    const otherStart = backend.calls.spawn.length;
    await runMessage({ ...other, text: "Which credentials are available?" });
    const [call] = attempts(otherStart);
    assert.deepEqual(namesOf(promptOf(call)), []);
    assert.equal(call.env.QA_SERVICE_TOKEN, undefined);
  });
}

test("cross-engine fallback and model retry retain the inventory matching each spawn", async () => {
  const ctx = await fixture("CREDENTIALS_FALLBACK", "claude", { model: "gpt-5.6" });
  const start = backend.calls.spawn.length;
  await runMessage({ ...ctx, text: "CLAUDE_STUB_LIMIT_FAIL_SAFE CODEX_STUB_REJECT_MODEL" });
  const calls = attempts(start);
  assert.equal(calls.length, 3);
  assert.match(promptOf(calls[0]), /"engine":"claude"/);
  assert.match(promptOf(calls[2]), /"engine":"codex"/);
  for (const call of calls) {
    assert.deepEqual(namesOf(promptOf(call)), ["QA_SERVICE_TOKEN"]);
    assert.equal(call.env.QA_SERVICE_TOKEN, fixtureValue);
    assert.ok(!promptOf(call).includes(fixtureValue));
  }
});

test("session healing uses the current inventory, including a credential removed before resuming", async (t) => {
  const ctx = await fixture("CREDENTIALS_HEAL", "claude");
  await runMessage({ ...ctx, text: "Start." });
  await patchChannelMeta(ctx.channel.slug, { env: {} });
  const original = backend.spawn;
  let resumes = 0;
  backend.spawn = (target, spec) => {
    if (spec.args.includes("-r")) {
      resumes++;
      assert.deepEqual(namesOf(promptOf(spec)), []);
      throw new Error("No conversation found with session ID: synthetic-lost-session");
    }
    return original(target, spec);
  };
  t.after(() => { backend.spawn = original; });
  const start = backend.calls.spawn.length;
  await runMessage({ ...ctx, text: "Continue.", getFallbackContext: async () => "Prior fixture conversation." });
  assert.equal(resumes, 1);
  const [healed] = attempts(start);
  assert.deepEqual(namesOf(promptOf(healed)), []);
  assert.match(promptOf(healed), /"session":"fresh"/);
});
