import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const {
  assertValidEnvName, assertValidEnvValue, channelEnvFingerprint, listChannelEnv,
  MAX_CHANNEL_ENV_VARS, normalizeChannelEnv, patchChannelEnv, resolveChannelEnv, safeSpawnEnv,
} = await import("../src/config/channel-env.js");
const { createSecretRedactor, redactSecretValues } = await import("../src/util/redact.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");
const { buildCodexEnv } = await import("../src/engines/codex.js");
const { buildSecretFormView, buildSecretsView, readSecretForm } = await import("../src/slack/secret-explorer.js");

const metaWith = (vars) => ({ env: vars });
const localVar = (value, extra = {}) => ({ provider: "local", value, setBy: "<@U1>", setAt: 1_700_000_000_000, ...extra });

// ── Names ───────────────────────────────────────────────────────────────────
// Injecting an arbitrary NAME is code execution, not configuration. These are the cases that make
// the reserved list part of the security boundary rather than an ergonomic nicety.
test("env names must look like env names", () => {
  assert.equal(assertValidEnvName("SUPABASE_ACCESS_TOKEN"), "SUPABASE_ACCESS_TOKEN");
  assert.equal(assertValidEnvName("  VERCEL_TOKEN  "), "VERCEL_TOKEN");
  for (const bad of ["", "lower_case", "1STARTS_WITH_DIGIT", "HAS-DASH", "HAS SPACE", "HAS$SIGN"]) {
    assert.throws(() => assertValidEnvName(bad), /valid name|Give the variable a name/, `"${bad}" must be refused`);
  }
});

test("names that would rewrite what the child executes are reserved", () => {
  for (const reserved of [
    "PATH", "HOME", "TMPDIR",                    // the daemon sets these itself
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", // load code into every child
    "NODE_OPTIONS", "PYTHONSTARTUP", "BASH_ENV", "PERL5OPT",  // interpreter hooks
    "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "PAGER",          // git will run these for you
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", // re-point the model itself
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CG_ANYTHING", "SLACK_BOT_TOKEN", "XDG_CONFIG_HOME",
  ]) {
    assert.throws(() => assertValidEnvName(reserved), /reserved/, `${reserved} must be reserved`);
  }
});

test("values must be a single pasted token", () => {
  assert.equal(assertValidEnvValue("sbp_0123456789abcdef"), "sbp_0123456789abcdef");
  assert.throws(() => assertValidEnvValue(""), /Give the variable a value/);
  assert.throws(() => assertValidEnvValue("KEY=value\nOTHER=value"), /line break/);
  assert.throws(() => assertValidEnvValue("x".repeat(20_000)), /too large/);
});

// ── The stored shape is tolerant on read, strict on write ───────────────────
test("a hand-edited store degrades instead of breaking a run", () => {
  const env = normalizeChannelEnv({
    GOOD: localVar("sbp_good_value_here"),
    lower: localVar("nope"),
    PATH: localVar("/tmp/evil"),               // reserved even if someone wrote it by hand
    WEIRD: "just-a-string",                     // not an entry object
  });
  assert.deepEqual(Object.keys(env), ["GOOD"]);
});

test("an unresolvable provider is kept and shown, not quietly dropped", () => {
  // Dropping it would hide a real variable from the listing AND let the run proceed without the
  // credential — the one outcome this design refuses. It stays visible; resolve is where it fails.
  const listed = listChannelEnv({ env: { VAULTED: { provider: "vault", ref: "kv/x" } } });
  assert.deepEqual(listed.map((v) => [v.name, v.provider, v.last4, v.resolvable]), [["VAULTED", "vault", "", false]]);
});

test("the maximum number of variables is enforced on add but not on replace", () => {
  let env = {};
  for (let i = 0; i < MAX_CHANNEL_ENV_VARS; i += 1) {
    env = patchChannelEnv(env, { set: { name: `VAR_${i}`, value: `value-number-${i}` }, actor: "<@U1>" });
  }
  assert.throws(() => patchChannelEnv(env, { set: { name: "ONE_TOO_MANY", value: "value-here-ok" } }), /maximum/);
  // Replacing an existing one is not an add.
  const replaced = patchChannelEnv(env, { set: { name: "VAR_0", value: "a-brand-new-value" } });
  assert.equal(Object.keys(replaced).length, MAX_CHANNEL_ENV_VARS);
});

test("removing a variable that isn't set says so instead of silently succeeding", () => {
  assert.throws(() => patchChannelEnv({}, { remove: "NOT_THERE" }), /is not set/);
});

test("a removal takes exactly one variable with it", () => {
  const env = patchChannelEnv(
    patchChannelEnv({}, { set: { name: "KEEP_ME", value: "keep-this-value" } }),
    { set: { name: "DROP_ME", value: "drop-this-value" } },
  );
  assert.deepEqual(Object.keys(patchChannelEnv(env, { remove: "DROP_ME" })), ["KEEP_ME"]);
});

test("a patch that asks for nothing is a mistake, not a no-op", () => {
  assert.throws(() => patchChannelEnv({}, {}), /Nothing to change/);
});

test("only providers this build actually has can be written or resolved", async () => {
  assert.throws(() => patchChannelEnv({}, { set: { name: "VAULTED", value: "v", provider: "vault" } }), /Unknown secret provider/);
  // And a row that names one anyway (hand-edited, or written by a later build) fails LOUDLY at
  // resolve time rather than resolving to "" — see the module header.
  await assert.rejects(
    () => resolveChannelEnv({ env: { VAULTED: { provider: "vault", ref: "kv/x" } } }),
    /VAULTED uses secret provider "vault", which this build cannot resolve/,
  );
});

test("a channel with nothing set resolves to nothing at all", async () => {
  assert.deepEqual(listChannelEnv({}), []);
  assert.deepEqual(await resolveChannelEnv({}), {});
  assert.deepEqual(await resolveChannelEnv({ env: null }), {});
});

// ── Write-only ──────────────────────────────────────────────────────────────
test("the listing shape carries no value, and no tail for a short one", () => {
  const meta = metaWith({
    LONG: localVar("sbp_long_enough_to_mask"),
    SHORT: localVar("abc123"),
  });
  const listed = listChannelEnv(meta);
  const body = JSON.stringify(listed);
  assert.ok(!body.includes("sbp_long_enough_to_mask"), "a value must never ride a listing");
  assert.ok(!body.includes("abc123"), "not even a short one");
  assert.deepEqual(listed.map((v) => v.name), ["LONG", "SHORT"], "sorted by name");
  assert.equal(listed[0].last4, "mask");
  assert.equal(listed[1].last4, "", "four characters of a six-character secret is a third of it");
  assert.equal(listed[0].setBy, "<@U1>");
});

test("no Slack view ever renders a value", () => {
  const meta = metaWith({ SUPABASE_ACCESS_TOKEN: localVar("sbp_secret_value_9999") });
  const state = { channelId: "C1", slug: "ops", ownerId: "U1" };
  const list = JSON.stringify(buildSecretsView(listChannelEnv(meta), state, { channelName: "ops", mayEdit: true }));
  assert.ok(!list.includes("sbp_secret_value_9999"));
  assert.ok(list.includes("SUPABASE_ACCESS_TOKEN") && list.includes("9999"), "the name and its tail are the point");
  // The update form is never pre-filled: there is nothing to pre-fill it with, and a box that
  // looks like it holds the old value invites someone to read it out.
  const form = JSON.stringify(buildSecretFormView(state, { channelName: "ops", name: "SUPABASE_ACCESS_TOKEN", suggested: ["SUPABASE_ACCESS_TOKEN"] }));
  assert.ok(!form.includes("sbp_secret_value_9999"));
});

test("the Slack form reads back exactly what was typed", () => {
  const view = { state: { values: {
    secret_name: { cg_channel_secrets_name_value: { value: "  SUPABASE_ACCESS_TOKEN " } },
    secret_value: { cg_channel_secrets_value_value: { value: " sbp_typed_value " } },
  } } };
  assert.deepEqual(readSecretForm(view), { name: "SUPABASE_ACCESS_TOKEN", value: "sbp_typed_value" });
});

// ── Injection ───────────────────────────────────────────────────────────────
test("resolved variables reach the child environment, and cannot displace the gateway's own", async () => {
  const meta = metaWith({ SUPABASE_ACCESS_TOKEN: localVar("sbp_injected_value") });
  const resolved = safeSpawnEnv(await resolveChannelEnv(meta));
  assert.deepEqual(resolved, { SUPABASE_ACCESS_TOKEN: "sbp_injected_value" });

  const claude = buildClaudeEnv({ home: "/gateway/home", configDir: "/gateway/home/.claude", extraEnv: { ...resolved, HOME: "/tmp/hijack", PATH: "/tmp/evil" } }, { PATH: "/usr/bin" });
  assert.equal(claude.SUPABASE_ACCESS_TOKEN, "sbp_injected_value");
  assert.equal(claude.HOME, "/gateway/home", "the engine's own home always wins");
  assert.equal(claude.PATH, "/usr/bin", "and so does its PATH");

  const codex = buildCodexEnv({ home: "/gateway/codex", codexHome: "/gateway/codex/.codex", extraEnv: { ...resolved, HOME: "/tmp/hijack" } }, { PATH: "/usr/bin" });
  assert.equal(codex.SUPABASE_ACCESS_TOKEN, "sbp_injected_value");
  assert.equal(codex.HOME, "/gateway/codex");
});

test("safeSpawnEnv is the merge-site half of the name rule", () => {
  // Validation on write is the primary gate; this exists so a hand-edited store cannot bypass it.
  assert.deepEqual(safeSpawnEnv({ OK_ONE: "value", LD_PRELOAD: "/tmp/x.so", PATH: "/tmp", lower: "v", EMPTY: "" }), { OK_ONE: "value" });
});

test("the warm-pool fingerprint tracks the values, not just the names", async () => {
  const before = channelEnvFingerprint(await resolveChannelEnv(metaWith({ TOKEN_NAME: localVar("value-one-here") })));
  const same = channelEnvFingerprint(await resolveChannelEnv(metaWith({ TOKEN_NAME: localVar("value-one-here") })));
  const rotated = channelEnvFingerprint(await resolveChannelEnv(metaWith({ TOKEN_NAME: localVar("value-two-here") })));
  assert.equal(before, same, "an unchanged secret must not retire a healthy warm process");
  assert.notEqual(before, rotated, "a rotated one must, or the pool answers with the old credential");
  assert.equal(channelEnvFingerprint({}), "");
  assert.ok(!before.includes("value-one-here"), "the fingerprint is a digest, never the values");
});

// ── Redaction ───────────────────────────────────────────────────────────────
// Write-only in the UI is not write-only at runtime: the agent can read its own environment.
test("secret values are redacted out of what a turn says", () => {
  assert.equal(
    redactSecretValues("token is sbp_secret_value_9999 ok", ["sbp_secret_value_9999"]),
    "token is [REDACTED] ok",
  );
  // Longest first, so a short secret that is a substring of a long one can't carve it up.
  assert.equal(redactSecretValues("AAABBBCCC", ["AAABBBCCC", "BBB"]), "[REDACTED]");
});

test("a value split across two deltas is still caught", async () => {
  const secret = "sbp_split_across_chunks_1234";
  const redactor = createSecretRedactor([secret]);
  let out = "";
  for (const chunk of ["here it is: sbp_split_", "across_chunks_1234 and done"]) out += redactor.push(chunk);
  out += redactor.flush();
  assert.equal(out, "here it is: [REDACTED] and done");
});

test("the streaming redactor emits everything it was given, in order", () => {
  const redactor = createSecretRedactor(["never-appears-here"]);
  let out = "";
  for (const chunk of ["the ", "quick ", "brown ", "fox"]) out += redactor.push(chunk);
  out += redactor.flush();
  assert.equal(out, "the quick brown fox", "holdback must be released, or answers lose their tail");
});

test("with no secrets the redactor is a pass-through", () => {
  const redactor = createSecretRedactor([]);
  assert.equal(redactor.push("anything at all"), "anything at all");
  assert.equal(redactor.flush(), "");
});

test("a value too short to be distinctive is never redacted, in either form", () => {
  // Replacing "abc" everywhere would mangle the answer to protect nothing, and the two redactors
  // must agree — finalize() checks the streamed text is a prefix of the final content.
  assert.equal(redactSecretValues("abc appears in abcdef", ["abc"]), "abc appears in abcdef");
  const redactor = createSecretRedactor(["abc"]);
  assert.equal(redactor.push("abc stays") + redactor.flush(), "abc stays");
});

// ── API surfaces ────────────────────────────────────────────────────────────
// Every listing path in the channels router spreads the stored meta, which is exactly how a new
// secret-shaped field leaks by accident. This is the regression guard for that spread.
const { maskChannelMeta } = await import("../src/web/routes/channels.js");

test("a masked channel meta carries names and tails, never values", () => {
  const masked = maskChannelMeta({
    name: "ops",
    composioToken: "comp_secret_1111",
    env: { SUPABASE_ACCESS_TOKEN: localVar("sbp_never_serve_this_2222") },
  });
  const body = JSON.stringify(masked);
  assert.ok(!body.includes("sbp_never_serve_this_2222"), "the env value must not ride a listing");
  assert.ok(!body.includes("comp_secret_1111"), "nor the channel's Composio token");
  assert.equal(masked.env, undefined, "the raw bag is dropped, not just shadowed");
  assert.deepEqual(masked.envVars, [{
    name: "SUPABASE_ACCESS_TOKEN", provider: "local", last4: "2222", resolvable: true,
    setBy: "<@U1>", setAt: 1_700_000_000_000,
  }]);
});
