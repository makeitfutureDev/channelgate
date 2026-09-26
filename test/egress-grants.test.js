// Placeholder grants (src/gateway/egress/grants.js) and the rule catalog behind them
// (src/gateway/egress/catalog-rules.js): what a proxy-mode container holds instead of a secret.
//
// What must hold: one stable placeholder per (scope, channel, owner, name); removing a secret
// revokes its placeholder and re-adding mints a new one; a personal placeholder is bound to its
// channel AND author; the organization's is shared by every channel; a name with no rule is raw and
// flagged (or withheld under strict); the redactor's list carries every real value; and no secret
// value is ever stored in the grants table.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const grants = await import("../src/gateway/egress/grants.js");
const { rulesFor, catalogRuleFor, assertValidSwapRuleFields, SECRET_NAME_RULES, RELAY_RULE } = await import("../src/gateway/egress/catalog-rules.js");
const { corePlaceholder, placeholderScope, PLACEHOLDER_RE } = await import("../src/gateway/egress/placeholders.js");
const { patchOrgEnv, patchUserEnv } = await import("../src/config/scoped-env.js");
const { patchChannelEnv } = await import("../src/config/channel-env.js");
const { upsertChannelEntry, patchChannelMeta, getChannelMeta, getChannelEntry, defaultChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { setEgressProvider } = await import("../src/runtimes/container/egress-hook.js");

const CH_A = "C_GRANTS_A";
const CH_B = "C_GRANTS_B";
const ALICE = "U_GRANTS_ALICE";
const BOB = "U_GRANTS_BOB";

// An isolated target whose egress plan is active: what the container backend hands a spawn site
// when the daemon's egress service is running.
function activeTarget(channelId, { strict = false } = {}) {
  return {
    backend: "container",
    runtime: { capabilities: { isolated: true } },
    slug: channelId.toLowerCase(),
    meta: { channelId },
    settings: { egressMode: "proxy", egressSecretsStrict: strict },
    container: { egress: { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/x", caBundle: "/y", caSpki: "z" } },
  };
}
const inactiveTarget = (channelId) => ({ ...activeTarget(channelId), container: { egress: { mode: "bridge", active: false, network: "bridge" } } });

async function channel(channelId, env = {}) {
  const entry = await upsertChannelEntry(channelId, { name: channelId, type: "channel", isDM: false, platform: "slack" });
  await patchChannelMeta(entry.slug, (existing) => {
    let next = existing?.env || {};
    for (const [name, value] of Object.entries(env)) next = patchChannelEnv(next, { set: { name, value: value.value ?? value, ...(value.hosts ? { hosts: value.hosts } : {}) } });
    return { ...(existing || defaultChannelMeta({ channelId, name: channelId, type: "channel", isDM: false })), env: next };
  });
  return getChannelMeta(entry.slug);
}

test("the catalog: GitHub, Vercel, Supabase, Make and Composio names are ruled; config names and passwords are not", () => {
  assert.deepEqual(catalogRuleFor("GITHUB_TOKEN").hosts, ["api.github.com", "github.com", "uploads.github.com", "*.githubusercontent.com"]);
  assert.deepEqual(catalogRuleFor("GH_TOKEN").format, ["bearer", "raw", "basic-password"], "git over https sends the PAT as the Basic password");
  assert.equal(catalogRuleFor("GITHUB_PAT_DEPLOY").id, "github");
  assert.equal(catalogRuleFor("GH_REPO"), null, "GH_REPO is configuration, not a credential");
  assert.equal(catalogRuleFor("GITHUB_REPOSITORY"), null);
  assert.equal(catalogRuleFor("VERCEL_TOKEN").id, "vercel");
  assert.equal(catalogRuleFor("VERCEL_ORG_ID"), null, "the Vercel CLI sends VERCEL_ORG_ID as a query parameter — never a placeholder");
  assert.equal(catalogRuleFor("SUPABASE_ACCESS_TOKEN").id, "supabase");
  assert.equal(catalogRuleFor("SUPABASE_DB_PASSWORD"), null, "a Postgres password rides a raw protocol no proxy can swap");
  assert.deepEqual(catalogRuleFor("MAKE_API_TOKEN").headers, ["authorization", "x-api-key"]);
  assert.ok(catalogRuleFor("MAKE_API_TOKEN").format.includes("bearer"), "`Authorization: Token <key>` is the bearer position; the prefix survives");
  assert.deepEqual(catalogRuleFor("COMPOSIO_API_KEY").headers, ["x-api-key"]);
  assert.equal(catalogRuleFor("OPENAI_API_KEY"), null);
  assert.equal(catalogRuleFor("MY_RANDOM_KEY"), null);
  assert.ok(SECRET_NAME_RULES.length >= 5);
  assert.deepEqual(RELAY_RULE.hosts, ["api.anthropic.com"]);
});

test("rulesFor: an entry's own hosts win; its headers/format refine; malformed declarations are refused on write", () => {
  assert.equal(rulesFor("MY_API_KEY", {}), null);
  const own = rulesFor("MY_API_KEY", { hosts: ["api.example.com", "*.example.net"] });
  assert.deepEqual(own, { hosts: ["api.example.com", "*.example.net"], headers: ["authorization"], format: ["bearer", "raw"], source: "entry" });
  const refined = rulesFor("GITHUB_TOKEN", { headers: ["x-token"] });
  assert.deepEqual(refined.headers, ["x-token"]);
  assert.equal(refined.source, "catalog:github");
  const override = rulesFor("GITHUB_TOKEN", { hosts: ["ghe.example.com"], format: "bearer" });
  assert.deepEqual(override.hosts, ["ghe.example.com"]);
  assert.deepEqual(override.format, ["bearer"]);

  assert.throws(() => assertValidSwapRuleFields({ hosts: ["10.0.0.1"] }), /not a host name/);
  assert.throws(() => assertValidSwapRuleFields({ hosts: ["*.*.example.com"] }), /not a host name/);
  assert.throws(() => assertValidSwapRuleFields({ hosts: Array.from({ length: 17 }, (_, i) => `h${i}.example.com`) }), /At most 16/);
  assert.throws(() => assertValidSwapRuleFields({ headers: ["host"] }), /not a header/);
  assert.throws(() => assertValidSwapRuleFields({ headers: Array.from({ length: 9 }, (_, i) => `x-h${i}`) }), /At most 8/);
  assert.throws(() => assertValidSwapRuleFields({ format: "digest" }), /not a secret format/);
  assert.deepEqual(assertValidSwapRuleFields({ hosts: "API.Example.com, *.example.org", headers: ["X-Api-Key"], format: ["raw"] }), {
    hosts: ["api.example.com", "*.example.org"], headers: ["x-api-key"], format: ["raw"],
  });
});

test("a stored rule survives a value rotation and is cleared only on purpose", () => {
  let env = patchChannelEnv({}, { set: { name: "MY_API_KEY", value: "first-value-12345", hosts: ["api.example.com"] } });
  env = patchChannelEnv(env, { set: { name: "MY_API_KEY", value: "second-value-12345" } });
  assert.deepEqual(env.MY_API_KEY.hosts, ["api.example.com"], "rotating from a surface that does not show the rule keeps it");
  env = patchChannelEnv(env, { set: { name: "MY_API_KEY", value: "third-value-123456", hosts: [] } });
  assert.equal(env.MY_API_KEY.hosts, undefined, "an explicit empty list clears it");
});

test("placeholders are stable per key, scoped by letter, and the table stores no value", async () => {
  const a = grants.placeholderFor({ scope: "channel", channelId: CH_A, secretName: "GITHUB_TOKEN" });
  assert.equal(grants.placeholderFor({ scope: "channel", channelId: CH_A, secretName: "GITHUB_TOKEN" }), a, "same key, same placeholder");
  assert.equal(corePlaceholder(a), a);
  assert.equal(placeholderScope(a), "channel");
  const b = grants.placeholderFor({ scope: "channel", channelId: CH_B, secretName: "GITHUB_TOKEN" });
  assert.notEqual(a, b, "another channel, another placeholder");
  const org = grants.placeholderFor({ scope: "organization", channelId: CH_A, secretName: "GH_TOKEN" });
  assert.equal(grants.placeholderFor({ scope: "organization", channelId: CH_B, secretName: "GH_TOKEN" }), org, "the organization's is shared by every channel");
  assert.equal(placeholderScope(org), "org");
  const alice = grants.placeholderFor({ scope: "personal", channelId: CH_A, ownerId: ALICE, secretName: "MY_PAT" });
  const bob = grants.placeholderFor({ scope: "personal", channelId: CH_A, ownerId: BOB, secretName: "MY_PAT" });
  const aliceElsewhere = grants.placeholderFor({ scope: "personal", channelId: CH_B, ownerId: ALICE, secretName: "MY_PAT" });
  assert.equal(new Set([alice, bob, aliceElsewhere]).size, 3, "personal = per channel AND author");
  assert.equal(grants.lookupGrant(alice).ownerId, ALICE);
  assert.throws(() => grants.placeholderFor({ scope: "personal", channelId: CH_A, secretName: "X" }), /needs an owner/);
  assert.throws(() => grants.placeholderFor({ scope: "channel", secretName: "X" }), /needs a channel/);

  const columns = getDb().prepare("PRAGMA table_info(egress_grants)").all().map((c) => c.name);
  assert.deepEqual(columns, ["placeholder", "scope", "channel_id", "owner_id", "secret_name", "created_ms", "revoked_ms"], "no value column, ever");
});

test("migration 30 created the table with the one-live-row-per-key index", () => {
  const version = getDb().prepare("PRAGMA user_version").get().user_version;
  assert.ok(version >= 30);
  const indexes = getDb().prepare("PRAGMA index_list(egress_grants)").all().map((i) => i.name);
  assert.ok(indexes.includes("idx_egress_grants_key"));
  assert.ok(indexes.includes("idx_egress_grants_channel"));
});

test("revoking kills the placeholder; re-adding mints a new one", () => {
  const first = grants.placeholderFor({ scope: "channel", channelId: CH_A, secretName: "VERCEL_TOKEN" });
  assert.ok(grants.lookupGrant(first));
  assert.equal(grants.revokeGrants({ scope: "channel", channelId: CH_A, secretName: "VERCEL_TOKEN" }), 1);
  assert.equal(grants.lookupGrant(first), null, "a revoked placeholder resolves to nothing");
  const second = grants.placeholderFor({ scope: "channel", channelId: CH_A, secretName: "VERCEL_TOKEN" });
  assert.notEqual(second, first);
});

test("resolveEgressRunEnv: inactive egress is exactly the real resolve", async () => {
  const meta = await channel("C_GRANTS_PLAIN", { GITHUB_TOKEN: "ghp_plain_value_0001", FREE_FORM: "free-form-value-0001" });
  const out = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_PLAIN", target: inactiveTarget("C_GRANTS_PLAIN") });
  assert.equal(out.env.GITHUB_TOKEN, "ghp_plain_value_0001");
  assert.equal(out.env.FREE_FORM, "free-form-value-0001");
  assert.deepEqual(out.placeholders, {});
  assert.deepEqual(out.unprotected, []);
  assert.ok(out.realValues.includes("ghp_plain_value_0001"));
  assert.deepEqual(await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_PLAIN", target: inactiveTarget("C_GRANTS_PLAIN"), clean: true }), { env: {}, scopes: {}, placeholders: {}, hosts: {}, unprotected: [], withheld: [], realValues: [] });
  // No target at all (an agent job resolves its own per turn), even with a running service: real values.
  setEgressProvider({ running: () => true, socketDirFor: () => "/x", caBundlePath: () => "/y" });
  try {
    const none = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_PLAIN", target: null });
    assert.equal(none.env.GITHUB_TOKEN, "ghp_plain_value_0001");
  } finally {
    setEgressProvider(null);
  }
});

test("resolveEgressRunEnv: ruled names become placeholders, unruled are flagged, realValues stay complete", async () => {
  patchOrgEnv({ set: { name: "GH_TOKEN", value: "ghp_org_value_000001" } });
  await patchUserEnv(ALICE, { set: { name: "ALICE_KEY", value: "alice-personal-value-1", hosts: ["api.alice.example"] } });
  const meta = await channel(CH_A, {
    SUPABASE_ACCESS_TOKEN: "sbp_channel_value_00001",
    SUPABASE_DB_PASSWORD: "db-password-value-001",
    CUSTOM_KEY: { value: "custom-value-000001", hosts: ["api.custom.example"] },
  });
  const out = await grants.resolveEgressRunEnv({ meta, channelId: CH_A, authorId: ALICE, target: activeTarget(CH_A) });

  for (const name of ["GH_TOKEN", "SUPABASE_ACCESS_TOKEN", "CUSTOM_KEY", "ALICE_KEY"]) {
    assert.match(out.env[name], /^cgph_[ocp][a-z2-7]{32}$/, `${name} is a placeholder`);
    assert.equal(out.placeholders[name], out.env[name]);
  }
  assert.equal(placeholderScope(out.env.GH_TOKEN), "org");
  assert.equal(placeholderScope(out.env.ALICE_KEY), "personal");
  assert.equal(placeholderScope(out.env.SUPABASE_ACCESS_TOKEN), "channel");
  assert.deepEqual(out.hosts.CUSTOM_KEY, ["api.custom.example"]);
  assert.equal(out.env.SUPABASE_DB_PASSWORD, "db-password-value-001", "no rule → raw");
  assert.deepEqual(out.unprotected, ["SUPABASE_DB_PASSWORD"]);
  assert.deepEqual(out.withheld, []);
  for (const real of ["ghp_org_value_000001", "alice-personal-value-1", "sbp_channel_value_00001", "db-password-value-001", "custom-value-000001"]) {
    assert.ok(out.realValues.includes(real), "every real value reaches the redactor");
    assert.ok(!Object.values(out.env).includes(real) || real === "db-password-value-001", "only the unprotected value is in the env");
  }
  const again = await grants.resolveEgressRunEnv({ meta, channelId: CH_A, authorId: ALICE, target: activeTarget(CH_A) });
  assert.deepEqual(again.placeholders, out.placeholders, "stable across runs");

  // The same channel, another author: the org and channel placeholders are shared, Alice's is not there.
  const bob = await grants.resolveEgressRunEnv({ meta, channelId: CH_A, authorId: BOB, target: activeTarget(CH_A) });
  assert.equal(bob.env.GH_TOKEN, out.env.GH_TOKEN);
  assert.equal(bob.env.SUPABASE_ACCESS_TOKEN, out.env.SUPABASE_ACCESS_TOKEN);
  assert.equal(bob.env.ALICE_KEY, undefined);
  // An untrusted principal (the HTTP run API) gets no personal scope and mints no personal grant.
  const api = await grants.resolveEgressRunEnv({ meta, channelId: CH_A, authorId: ALICE, untrustedPrincipal: true, target: activeTarget(CH_A) });
  assert.equal(api.env.ALICE_KEY, undefined);
});

test("strict mode withholds unruled secrets instead of injecting them raw", async () => {
  const meta = await channel("C_GRANTS_STRICT", { GITHUB_TOKEN: "ghp_strict_value_0001", RAW_ONLY: "raw-only-value-00001" });
  const out = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_STRICT", target: activeTarget("C_GRANTS_STRICT", { strict: true }) });
  assert.equal(out.env.RAW_ONLY, undefined);
  assert.deepEqual(out.withheld, ["RAW_ONLY"]);
  assert.deepEqual(out.unprotected, []);
  assert.ok(out.realValues.includes("raw-only-value-00001"), "withheld values are still redacted");
});

test("the resolver swaps in the CURRENT value, and a removed secret's placeholder dies", async () => {
  grants.__resetGrantCaches();
  const meta = await channel("C_GRANTS_LIVE", { GITHUB_TOKEN: "ghp_live_value_000001" });
  const out = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_LIVE", target: activeTarget("C_GRANTS_LIVE") });
  const ph = out.env.GITHUB_TOKEN;
  const grant = await grants.resolveEgressGrant(ph);
  assert.equal(grant.value, "ghp_live_value_000001");
  assert.equal(grant.secretName, "GITHUB_TOKEN");
  assert.equal(grant.scope, "channel");
  assert.equal(grant.channelId, "C_GRANTS_LIVE");
  assert.deepEqual(grant.hosts, catalogRuleFor("GITHUB_TOKEN").hosts);

  // Rotation: the same placeholder, the new value (after the short material cache).
  await channel("C_GRANTS_LIVE", { GITHUB_TOKEN: "ghp_rotated_value_0001" });
  grants.__resetGrantCaches();
  assert.equal((await grants.resolveEgressGrant(ph)).value, "ghp_rotated_value_0001");

  // Removal, seen by the resolver itself (no change listener in this process).
  const { slug } = await getChannelEntry("C_GRANTS_LIVE");
  await patchChannelMeta(slug, (existing) => ({ env: patchChannelEnv(existing?.env, { remove: "GITHUB_TOKEN" }) }));
  grants.__resetGrantCaches();
  assert.equal(await grants.resolveEgressGrant(ph), null);
  assert.equal(grants.lookupGrant(ph), null, "revoked, not just unresolved");
  // Re-adding mints a new one.
  const readded = await channel("C_GRANTS_LIVE", { GITHUB_TOKEN: "ghp_readded_value_0001" });
  const next = await grants.resolveEgressRunEnv({ meta: readded, channelId: "C_GRANTS_LIVE", target: activeTarget("C_GRANTS_LIVE") });
  assert.notEqual(next.env.GITHUB_TOKEN, ph);
});

test("a run reconciles: a secret removed since the last run loses its placeholder", async () => {
  patchOrgEnv({ set: { name: "GITHUB_TEMP_TOKEN", value: "ghp_org_temp_value_001" } });
  const meta = await channel("C_GRANTS_REC", {});
  const first = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_REC", target: activeTarget("C_GRANTS_REC") });
  const ph = first.env.GITHUB_TEMP_TOKEN;
  assert.ok(grants.lookupGrant(ph));
  patchOrgEnv({ remove: "GITHUB_TEMP_TOKEN" });
  await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_REC", target: activeTarget("C_GRANTS_REC") });
  assert.equal(grants.lookupGrant(ph), null);
});

test("a secret that briefly resolves EMPTY keeps its placeholder (grants are kept by stored names)", async () => {
  const meta = await channel("C_GRANTS_FLAKY", { GITHUB_TOKEN: "ghp_flaky_value_000001" });
  const first = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_FLAKY", target: activeTarget("C_GRANTS_FLAKY") });
  const ph = first.env.GITHUB_TOKEN;
  // A provider hiccup: the entry is still stored, its value did not resolve this time.
  const hiccup = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_FLAKY", target: activeTarget("C_GRANTS_FLAKY"), deps: { resolveChannelEnv: async () => ({}) } });
  assert.equal(hiccup.env.GITHUB_TOKEN, undefined);
  assert.ok(grants.lookupGrant(ph), "not revoked: warm processes still hold this placeholder");
  const after = await grants.resolveEgressRunEnv({ meta, channelId: "C_GRANTS_FLAKY", target: activeTarget("C_GRANTS_FLAKY") });
  assert.equal(after.env.GITHUB_TOKEN, ph, "the same placeholder, not a new one");
});

test("the Claude relay: a shaped placeholder per channel when egress is active, the real token otherwise", () => {
  const relay = { token: "sk-ant-oat01-REAL-ACCESS-TOKEN", source: "operator", expiresAt: 123, login: { file: "/x" } };
  const shaped = grants.containerClaudeCredential({ target: activeTarget(CH_A), relay, channelId: CH_A });
  assert.match(shaped.token, /^sk-ant-oat01-cgph_r[a-z2-7]{32}$/);
  assert.equal(shaped.placeholder, true);
  assert.equal(shaped.expiresAt, 123, "the warm pool still keys on the real login's expiry");
  assert.equal(shaped.source, "operator");
  assert.equal([...shaped.token.matchAll(PLACEHOLDER_RE)].length, 1, "the proxy matches the shaped token as one");
  assert.equal(grants.lookupGrant(corePlaceholder(shaped.token)).secretName, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(grants.containerClaudeCredential({ target: activeTarget(CH_A), relay, channelId: CH_A }).token, shaped.token, "stable per channel");
  assert.notEqual(grants.containerClaudeCredential({ target: activeTarget(CH_B), relay, channelId: CH_B }).token, shaped.token);
  assert.equal(grants.containerClaudeCredential({ target: inactiveTarget(CH_A), relay, channelId: CH_A }), relay);
  const keyed = { token: "", source: "api-key" };
  assert.equal(grants.containerClaudeCredential({ target: activeTarget(CH_A), relay: keyed, channelId: CH_A }), keyed);
});

test("the relay grant resolves the live relay token, cached for a minute", async () => {
  grants.__resetGrantCaches();
  const ph = grants.relayPlaceholderFor({ channelId: "C_GRANTS_RELAY" });
  let calls = 0;
  const deps = { relayToken: async () => { calls += 1; return { token: `relay-token-${calls}` }; } };
  const first = await grants.resolveEgressGrant(ph, deps);
  assert.equal(first.value, "relay-token-1");
  assert.deepEqual(first.hosts, ["api.anthropic.com"]);
  assert.deepEqual(first.headers, ["authorization"]);
  grants.__resetGrantCaches();
  assert.equal((await grants.resolveEgressGrant(ph, deps)).value, "relay-token-2");
});

test.after(() => setEgressProvider(null));
