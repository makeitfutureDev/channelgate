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
  assert.match(prompt, /never silently substitute one scope's credential for another's/);
});

// Container-secrets P2: with the egress proxy as the container's network, the inventory says which
// names hold a placeholder (and where it works), which hold the raw value, and which strict mode
// withheld — names and hosts only, never a value or the placeholder itself.
test("the egress lines: proxy-protected placeholders with their hosts, unprotected raw names, withheld names", () => {
  const placeholder = "cgph_cabcdefghijklmnopqrstuvwxyz234567";
  const prompt = channelCredentialsPreamble(
    { GITHUB_TOKEN: placeholder, SUPABASE_DB_PASSWORD: fixtureValue },
    {
      scopes: { GITHUB_TOKEN: "channel", SUPABASE_DB_PASSWORD: "channel" },
      placeholders: { GITHUB_TOKEN: placeholder },
      hosts: { GITHUB_TOKEN: ["api.github.com", "github.com"] },
      unprotected: ["SUPABASE_DB_PASSWORD"],
      withheld: ["LEGACY_KEY"],
    },
  );
  assert.deepEqual(namesOf(prompt), ["GITHUB_TOKEN", "SUPABASE_DB_PASSWORD"]);
  assert.match(prompt, /GITHUB_TOKEN is proxy-protected: its value in the environment is a placeholder that only works from this container through the gateway's egress proxy on: api\.github\.com, github\.com\./);
  assert.match(prompt, /Unprotected \(the RAW value is in the environment[^\n]*\["SUPABASE_DB_PASSWORD"\]/);
  assert.match(prompt, /Withheld by the gateway's strict egress setting[^\n]*\["LEGACY_KEY"\]/);
  assert.ok(!prompt.includes(placeholder), "the placeholder string itself is not repeated into the prompt");
  assert.ok(!prompt.includes(fixtureValue));
  // A personal placeholder says it PAUSES while another person works here.
  const personalPh = "cgph_pabcdefghijklmnopqrstuvwxyz234567";
  const withPersonal = channelCredentialsPreamble(
    { MY_PAT: personalPh },
    { scopes: { MY_PAT: "personal" }, placeholders: { MY_PAT: personalPh }, hosts: { MY_PAT: ["api.github.com"] } },
  );
  assert.match(withPersonal, /Personal placeholders \["MY_PAT"\] work only while their owner is the one working in this conversation: they PAUSE[^\n]*another-author-active[^\n]*another person's turn, background job or SSH session/);
  assert.doesNotMatch(prompt, /Personal placeholders/, "no personal line without a personal placeholder");
  // Without egress facts (legacy bridge mode, the host) none of these lines appear.
  const plain = channelCredentialsPreamble({ GITHUB_TOKEN: fixtureValue });
  assert.doesNotMatch(plain, /proxy-protected|Unprotected|Withheld/);
  assert.doesNotMatch(prompt, /PAUSED/, "no pause line unless the resolver says so");
});

// Container-secrets P3: while another person has an SSH session open in the channel, the proxy
// refuses the author's PERSONAL placeholders; the inventory says so instead of letting the agent
// read the 403 as a broken credential.
test("the pause line names only the personal placeholders, and only when paused", () => {
  const personal = "cgph_pabcdefghijklmnopqrstuvwxyz234567";
  const channel = "cgph_cabcdefghijklmnopqrstuvwxyz234567";
  const resolved = { MY_KEY: personal, GITHUB_TOKEN: channel };
  const facts = {
    scopes: { MY_KEY: "personal", GITHUB_TOKEN: "channel" },
    placeholders: { MY_KEY: personal, GITHUB_TOKEN: channel },
    hosts: { MY_KEY: ["api.example.com"], GITHUB_TOKEN: ["api.github.com"] },
  };
  const paused = channelCredentialsPreamble(resolved, { ...facts, personalPaused: true });
  assert.match(paused, /Personal secrets are PAUSED right now: another person.s turn, background job or SSH session is active[^\n]*\["MY_KEY"\][^\n]*another-person-ssh-session/);
  assert.doesNotMatch(paused, /PAUSED[^\n]*GITHUB_TOKEN/, "a channel secret is not paused");
  assert.ok(!paused.includes(personal) && !paused.includes(channel));
  assert.doesNotMatch(channelCredentialsPreamble(resolved, { ...facts, personalPaused: false }), /PAUSED/);
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
