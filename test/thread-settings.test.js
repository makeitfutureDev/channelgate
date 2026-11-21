// Thread-scoped settings (src/gateway/thread-settings.js) and their egress half: a thread's own
// variables, MCP connections and skill additions.
//
// The security contract pinned here: a thread variable is only ever a `thread` placeholder bound
// to (channel, thread key), swapped on fixed destination hosts while that thread is the only live
// work in the channel; it never reaches a sibling thread, another channel, a host/bridge run or a
// listing; removing it revokes its placeholder at once; and a thread cannot add a personal skill or
// a value without a fixed destination.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const settings = await import("../src/gateway/thread-settings.js");
const grants = await import("../src/gateway/egress/grants.js");
const liveness = await import("../src/gateway/egress/liveness.js");
const { canUseGrant } = await import("../src/gateway/egress/service.js");
const { onConfigChange } = await import("../src/config/change-events.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { resolveRunAccessGrants } = await import("../src/gateway/access-grants.js");
const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");

const GH_CHANNEL = "ghp_channel_value_thread_settings_0001";
const GH_THREAD = "ghp_thread_value_thread_settings_0002";
const API_THREAD = "thread-declared-api-value-0003";

function activeTarget(channelId) {
  return { backend: "container", runtime: { capabilities: { isolated: true } }, slug: channelId.toLowerCase(), meta: { channelId },
    settings: { egressMode: "proxy", egressSecretsStrict: true },
    container: { egress: { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/x", caBundle: "/y", caSpki: "z" } } };
}
const bridgeTarget = (channelId) => ({ ...activeTarget(channelId), container: { egress: { mode: "bridge", active: false, network: "bridge" } } });
const hostTarget = (channelId) => ({ backend: "host", runtime: { capabilities: { isolated: false } }, slug: channelId.toLowerCase(), meta: { channelId } });

let sequence = 0;
async function channel(env = {}) {
  const channelId = `C_THREADSET_${++sequence}`;
  const entry = await upsertChannelEntry(channelId, { name: channelId, type: "channel", isDM: false, platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId, type: "channel", env });
  return { channelId, slug: entry.slug };
}
const local = (value, extra = {}) => ({ provider: "local", value, setBy: "U1", setAt: 1, ...extra });

test("thread variables need a fixed destination; readable and approval-only values are refused on write", () => {
  // A known credential name carries its catalog hosts; a declared host list is a fixed destination too.
  assert.ok(settings.validateThreadSection("secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } }).env.GITHUB_TOKEN);
  assert.ok(settings.validateThreadSection("secrets", { env: { ACME_API_KEY: local(API_THREAD, { hosts: ["api.acme.example"] }) } }).env.ACME_API_KEY);
  // A password (readable kind) and an unknown API key with no hosts (admin approval per server) are not.
  assert.throws(() => settings.validateThreadSection("secrets", { env: { DB_PASSWORD: local("hunter2-thread-value") } }), /fixed destination/);
  assert.throws(() => settings.validateThreadSection("secrets", { env: { ACME_API_KEY: local(API_THREAD) } }), /fixed destination/);
  // Forcing readable, or carrying an admin's approved servers over, is not a way around it.
  const stripped = settings.validateThreadSection("secrets", { env: { GITHUB_TOKEN: local(GH_THREAD, { exposure: "readable", approvedHosts: ["evil.example"] }) } });
  assert.equal(stripped.env.GITHUB_TOKEN.exposure, undefined, "a thread variable can never be stored readable");
  assert.equal(stripped.env.GITHUB_TOKEN.approvedHosts, undefined);
  assert.equal(settings.threadVariableRule("GITHUB_TOKEN", { ...stripped.env.GITHUB_TOKEN, exposure: "readable" }), null, "and a readable entry never resolves a rule");
  // Reserved names, other providers, set-and-hidden and unknown fields are refused.
  assert.throws(() => settings.validateThreadSection("secrets", { env: { LD_PRELOAD: local("/tmp/x.so") } }), /reserved/);
  assert.throws(() => settings.validateThreadSection("secrets", { env: { GITHUB_TOKEN: { provider: "vault", ref: "x" } } }), /stored by ChannelGate/);
  assert.throws(() => settings.validateThreadSection("secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) }, removed: ["GITHUB_TOKEN"] }), /both set and hidden/);
  assert.throws(() => settings.validateThreadSection("secrets", { allowNetwork: true }), /Unsupported/);
  assert.throws(() => settings.validateThreadSection("mcp", { adminMode: true }), /Unsupported/);
  assert.throws(() => settings.validateThreadSection("skills", { skillTemplate: "x" }), /Unsupported/);
});

test("thread MCP connections validate Make pairs, labels and token length", () => {
  assert.deepEqual(settings.validateThreadSection("mcp", { composioToken: "thread-composio-token", composioTokenLabel: "Ops" }), { composioToken: "thread-composio-token", composioTokenLabel: "Ops" });
  assert.deepEqual(settings.validateThreadSection("mcp", { composioToken: "" }), { composioToken: "" });
  assert.throws(() => settings.validateThreadSection("mcp", { composioToken: "abc" }), /six characters/);
  assert.throws(() => settings.validateThreadSection("mcp", { composioTokenLabel: "Ops" }), /needs its own Composio token/);
  assert.throws(() => settings.validateThreadSection("mcp", { makeToolboxUrl: "https://eu1.make.com/mcp/server/x" }), /both its URL and its token/);
  assert.throws(() => settings.validateThreadSection("mcp", { makeToolboxUrl: "http://127.0.0.1/mcp", makeToolboxKey: "make-thread-key" }));
  assert.throws(() => settings.validateThreadSection("mcp", { allowedMcps: [{ notAnIdentity: true }] }), /Invalid thread MCP selection/);
  assert.deepEqual(settings.threadConnectionMeta({ composioToken: "channel-token", makeToolboxUrl: "u", makeToolboxKey: "k" }, { composioToken: "" }),
    { composioToken: "", composioTokenLabel: "", makeToolboxUrl: "u", makeToolboxKey: "k", threadComposioOverride: true });
});

test("a section is written whole with compare-and-swap, emits a value-free change, and a broken row applies nothing", async () => {
  const { slug } = await channel();
  const changes = [];
  const stop = onConfigChange((change) => changes.push(change));
  try {
    const before = settings.threadSectionFingerprint(slug, "T1", "secrets");
    settings.setThreadSettings(slug, "T1", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } }, { expected: before });
    assert.throws(() => settings.setThreadSettings(slug, "T1", "secrets", {}, { expected: before }), /changed while you were editing/);
    assert.ok(settings.getThreadSettings(slug, "T1", "secrets").env.GITHUB_TOKEN, "the refused write changed nothing");
    assert.deepEqual(settings.getThreadSettings(slug, "T2", "secrets"), {}, "a sibling thread has no overrides");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(changes.some((change) => change.kind === "thread-settings" && change.threadKey === "T1" && change.section === "secrets"));
    assert.ok(!JSON.stringify(changes).includes(GH_THREAD), "a change event never carries a value");
  } finally { stop(); }
  // A hand-edited row that no longer validates is read fail-closed, never dropped: its variable
  // names stay (and are withheld at run time), a malformed connection reads as disconnected.
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?)").run(slug, "T3", "settings_secrets", JSON.stringify({ env: { DB_PASSWORD: local("x") } }));
  assert.deepEqual(Object.keys(settings.getThreadSettings(slug, "T3", "secrets").env), ["DB_PASSWORD"]);
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?)").run(slug, "T3", "settings_mcp", JSON.stringify({ composioToken: "abc", makeToolboxUrl: "http://127.0.0.1/x", makeToolboxKey: "make-key-123", adminMode: true }));
  assert.deepEqual(settings.getThreadSettings(slug, "T3", "mcp"), { composioToken: "", makeToolboxUrl: "", makeToolboxKey: "" });
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?)").run(slug, "T3", "settings_skills", "{not json");
  assert.deepEqual(settings.getThreadSettings(slug, "T3", "skills"), {});
  // Fingerprints are keyed digests, never the value.
  assert.ok(!settings.threadSectionFingerprint(slug, "T1", "secrets").includes(GH_THREAD));
});

test("thread placeholders win in their own thread only; siblings and other channels keep the channel value", async () => {
  const { channelId, slug } = await channel({ GITHUB_TOKEN: local(GH_CHANNEL) });
  settings.setThreadSettings(slug, "T-own", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  const meta = { channelId, env: { GITHUB_TOKEN: local(GH_CHANNEL) } };
  const threadEnv = settings.getThreadSettings(slug, "T-own", "secrets");
  const own = await grants.resolveEgressRunEnv({ meta, channelId, authorId: "U1", target: activeTarget(channelId), thread: { key: "T-own", ...threadEnv } });
  assert.equal(own.scopes.GITHUB_TOKEN, "thread");
  const row = grants.lookupGrant(own.env.GITHUB_TOKEN);
  assert.deepEqual([row.scope, row.channelId, row.ownerId, row.secretName], ["thread", channelId, "T-own", "GITHUB_TOKEN"]);
  const serialized = JSON.stringify({ env: own.env, scopes: own.scopes, hosts: own.hosts, placeholders: own.placeholders });
  assert.ok(!serialized.includes(GH_THREAD) && !serialized.includes(GH_CHANNEL), "no real value is in the run environment");
  assert.ok(own.redactionValues.includes(GH_THREAD), "the thread value is redacted from output");
  // The sibling thread resolves the CHANNEL placeholder, never the thread's.
  const sibling = await grants.resolveEgressRunEnv({ meta, channelId, authorId: "U1", target: activeTarget(channelId), thread: { key: "T-sibling", ...settings.getThreadSettings(slug, "T-sibling", "secrets") } });
  assert.equal(sibling.scopes.GITHUB_TOKEN, "channel");
  assert.notEqual(sibling.env.GITHUB_TOKEN, own.env.GITHUB_TOKEN);
  assert.ok(!sibling.redactionValues.includes(GH_THREAD));
  // The grant row stores where the value lives, never the value.
  assert.ok(!JSON.stringify(getDb().prepare("SELECT * FROM egress_grants").all()).includes(GH_THREAD));
  // The proxy resolves the thread placeholder only from that thread's own store.
  const resolved = await grants.resolveEgressGrant(own.env.GITHUB_TOKEN);
  assert.equal(resolved.value, GH_THREAD);
  assert.equal(resolved.scope, "thread");
  assert.equal(resolved.owner, "T-own");
  // The preamble names thread variables, never their values.
  const preamble = channelCredentialsPreamble(own.env, { scopes: own.scopes, placeholders: own.placeholders, hosts: own.hosts, threadPaused: own.threadPaused });
  assert.match(preamble, /This thread's own variables[^\n]*\["GITHUB_TOKEN"\]/);
  assert.match(preamble, /Thread placeholders \["GITHUB_TOKEN"\][^\n]*PAUSE/);
  assert.ok(!preamble.includes(GH_THREAD));
});

test("outside a proxy-mode container a thread variable is withheld and its name is not filled from the channel", async () => {
  const { channelId, slug } = await channel({ GITHUB_TOKEN: local(GH_CHANNEL), OTHER_TOKEN: local("other-channel-token-value", { hosts: ["api.other.example"] }) });
  settings.setThreadSettings(slug, "T-host", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  const meta = { channelId, env: { GITHUB_TOKEN: local(GH_CHANNEL), OTHER_TOKEN: local("other-channel-token-value", { hosts: ["api.other.example"] }) } };
  for (const target of [bridgeTarget(channelId), hostTarget(channelId), null]) {
    const out = await grants.resolveEgressRunEnv({ meta, channelId, authorId: "U1", target, thread: { key: "T-host", ...settings.getThreadSettings(slug, "T-host", "secrets") } });
    assert.equal(out.env.GITHUB_TOKEN, undefined, "neither the thread value nor the channel value is injected");
    assert.deepEqual(out.threadWithheld, ["GITHUB_TOKEN"]);
    assert.equal(out.env.OTHER_TOKEN, "other-channel-token-value", "unrelated channel variables keep today's behavior");
    assert.ok(!JSON.stringify(out.env).includes(GH_THREAD));
    assert.match(channelCredentialsPreamble(out.env, { scopes: out.scopes, threadWithheld: out.threadWithheld }), /Withheld thread variables[^\n]*\["GITHUB_TOKEN"\]/);
  }
});

test("a stored thread variable that lost its fixed destination is withheld, never replaced by the channel's", async () => {
  const { channelId, slug } = await channel({ DB_PASSWORD: local("channel-db-password-0001") });
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?)").run(slug, "T-stale", "settings_secrets", JSON.stringify({ env: { DB_PASSWORD: local("thread-db-password-0002") } }));
  const meta = { channelId, env: { DB_PASSWORD: local("channel-db-password-0001") } };
  // On a raw (bridge) target the channel's password would be injected as is; for this thread it must not be.
  assert.equal((await grants.resolveEgressRunEnv({ meta, channelId, target: bridgeTarget(channelId), thread: { key: "T-other" } })).env.DB_PASSWORD, "channel-db-password-0001");
  for (const target of [bridgeTarget(channelId), activeTarget(channelId)]) {
    const out = await grants.resolveEgressRunEnv({ meta, channelId, target, thread: { key: "T-stale", ...settings.getThreadSettings(slug, "T-stale", "secrets") } });
    assert.equal(out.env.DB_PASSWORD, undefined);
    assert.deepEqual(out.threadWithheld, ["DB_PASSWORD"]);
    assert.ok(!JSON.stringify(out.env).includes("password-000"));
  }
});

test("hiding a channel variable in a thread narrows only that thread", async () => {
  const { channelId, slug } = await channel({ GITHUB_TOKEN: local(GH_CHANNEL) });
  settings.setThreadSettings(slug, "T-hide", "secrets", { removed: ["GITHUB_TOKEN"] });
  const meta = { channelId, env: { GITHUB_TOKEN: local(GH_CHANNEL) } };
  const hidden = await grants.resolveEgressRunEnv({ meta, channelId, target: activeTarget(channelId), thread: { key: "T-hide", ...settings.getThreadSettings(slug, "T-hide", "secrets") } });
  assert.equal(hidden.env.GITHUB_TOKEN, undefined);
  const other = await grants.resolveEgressRunEnv({ meta, channelId, target: activeTarget(channelId), thread: { key: "T-other" } });
  assert.equal(other.scopes.GITHUB_TOKEN, "channel");
});

test("the proxy swaps a thread grant only while that thread is the only live work in its channel", async () => {
  liveness.__resetLiveness();
  const grant = { scope: "thread", channelId: "C_LIVE", owner: "T-live" };
  const ctx = { channelId: "C_LIVE", slug: "c_live" };
  assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "thread-not-live" });
  const releaseOwn = liveness.markLive({ channelId: "C_LIVE", ownerId: "U1", kind: "turn", id: "T-live" });
  assert.deepEqual(canUseGrant(grant, ctx), { ok: true });
  assert.deepEqual(canUseGrant(grant, { channelId: "C_OTHER", slug: "c_other" }), { ok: false, reason: "other-channel" });
  assert.deepEqual(canUseGrant({ ...grant, owner: "" }, ctx), { ok: false, reason: "thread-not-live" });
  assert.deepEqual(canUseGrant({ ...grant, scope: "made-up" }, ctx), { ok: false, reason: "unknown-scope" });
  // A background agent of the same thread (synthetic key, signed settings thread) is the thread's work.
  const releaseAgent = liveness.markLive({ channelId: "C_LIVE", ownerId: "U1", kind: "turn", id: "T-live::agent-abc", threadKey: "T-live" });
  assert.deepEqual(canUseGrant(grant, ctx), { ok: true });
  releaseAgent();
  // A sibling thread's turn, a job with no settings thread, a memory review or an SSH session pauses it.
  for (const other of [{ kind: "turn", id: "T-sibling" }, { kind: "job", id: "job-1" }, { kind: "review", id: "review-1" }]) {
    const release = liveness.markLive({ channelId: "C_LIVE", ownerId: "U2", ...other });
    assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "another-thread-active" }, other.kind);
    release();
  }
  liveness.__setSshSessionSource(() => [{ channelId: "C_LIVE", userId: "U1" }]);
  assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "another-thread-active" }, "even the same person's SSH session");
  liveness.__setSshSessionSource(null);
  releaseOwn();
  assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "thread-not-live" });
  liveness.__resetLiveness();
});

test("removing a thread variable revokes its placeholder at once, even without the change listener", async () => {
  const { channelId, slug } = await channel();
  settings.setThreadSettings(slug, "T-revoke", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  const meta = { channelId, env: {} };
  const first = await grants.resolveEgressRunEnv({ meta, channelId, target: activeTarget(channelId), thread: { key: "T-revoke", ...settings.getThreadSettings(slug, "T-revoke", "secrets") } });
  const placeholder = first.env.GITHUB_TOKEN;
  assert.equal((await grants.resolveEgressGrant(placeholder)).value, GH_THREAD);
  // Removed by a direct row delete (as a thread deletion or another connection would): the next
  // swap resolves live from the store, finds nothing and revokes.
  getDb().prepare("DELETE FROM thread_overrides WHERE slug = ? AND thread_key = ?").run(slug, "T-revoke");
  assert.equal(await grants.resolveEgressGrant(placeholder), null);
  assert.equal(grants.lookupGrant(placeholder), null, "the placeholder is revoked");
  // Re-adding mints a NEW placeholder; the old one stays dead.
  settings.setThreadSettings(slug, "T-revoke", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  const again = await grants.resolveEgressRunEnv({ meta, channelId, target: activeTarget(channelId), thread: { key: "T-revoke", ...settings.getThreadSettings(slug, "T-revoke", "secrets") } });
  assert.notEqual(again.env.GITHUB_TOKEN, placeholder);
  assert.equal(await grants.resolveEgressGrant(placeholder), null);
  // A rotated value is live; an emptied section revokes at the next resolve.
  settings.setThreadSettings(slug, "T-revoke", "secrets", {});
  await grants.resolveEgressRunEnv({ meta, channelId, target: activeTarget(channelId), thread: { key: "T-revoke" } });
  assert.equal(grants.lookupGrant(again.env.GITHUB_TOKEN), null);
});

test("a thread grant row cannot be borrowed by another thread or channel with the same variable name", async () => {
  const a = await channel(), b = await channel();
  settings.setThreadSettings(a.slug, "T-a", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  settings.setThreadSettings(b.slug, "T-a", "secrets", { env: { GITHUB_TOKEN: local("ghp_other_channel_same_thread_key_0009") } });
  const out = await grants.resolveEgressRunEnv({ meta: { channelId: a.channelId }, channelId: a.channelId, target: activeTarget(a.channelId), thread: { key: "T-a", ...settings.getThreadSettings(a.slug, "T-a", "secrets") } });
  const resolved = await grants.resolveEgressGrant(out.env.GITHUB_TOKEN);
  assert.equal(resolved.value, GH_THREAD, "resolved through the issuing channel's own thread row");
  assert.equal(resolved.channelId, a.channelId);
  assert.throws(() => grants.placeholderFor({ scope: "thread", channelId: a.channelId, secretName: "GITHUB_TOKEN" }), /needs an owner/);
});

test("thread skills join the run's effective grants only, and never a personal skill", async () => {
  const lookupSkill = (name) => ({ shared: { slug: "shared", visibility: "org" }, mine: { slug: "mine", visibility: "personal", createdBy: "U1" },
    needsMine: { slug: "needsMine", visibility: "org", requires: ["mine"] } })[name] || null;
  const grantsOut = await resolveRunAccessGrants({ channel: { skills: ["base"] }, thread: { skills: ["shared", "mine", "needsMine"], allowedMcps: [{ name: "thread-mcp" }] }, authorId: "U1", lookupSkill, loadUser: async () => ({}) });
  assert.deepEqual(grantsOut.shared.skills, ["base"], "the durable channel tier never changes");
  assert.deepEqual(grantsOut.effective.skills, ["base", "shared"]);
  assert.deepEqual(grantsOut.effective.allowedMcps.map((item) => item.name), ["thread-mcp"]);
  assert.deepEqual(grantsOut.skippedSkills.map((item) => [item.name, item.tier]), [["mine", "thread"], ["needsMine", "thread"]]);
  // The write-side check refuses the same.
  assert.doesNotThrow(() => settings.assertThreadSkillGrantable("shared", { channelId: "C1", lookupSkill }));
  assert.throws(() => settings.assertThreadSkillGrantable("mine", { channelId: "C1", lookupSkill }), /personal skill/);
  assert.throws(() => settings.assertThreadSkillGrantable("needsMine", { channelId: "C1", lookupSkill }), /requires the personal skill/);
  assert.throws(() => settings.assertThreadSkillGrantable("absent", { channelId: "C1", lookupSkill }), /no longer available/);
  assert.throws(() => settings.assertThreadSkillGrantable("scoped", { channelId: "C1", lookupSkill: () => ({ slug: "scoped", visibility: "org", channelScope: "C2" }) }), /another conversation/);
});

test("an unreadable variables or connections row refuses runs instead of falling back to the channel", async () => {
  const { slug } = await channel({ GITHUB_TOKEN: local(GH_CHANNEL) });
  const put = (key, kind, value) => getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?) ON CONFLICT(slug, thread_key, kind) DO UPDATE SET value = excluded.value").run(slug, key, kind, value);
  for (const [key, kind, value] of [
    ["T-u1", "settings_secrets", "{not json"], ["T-u2", "settings_secrets", "null"], ["T-u3", "settings_secrets", JSON.stringify({ env: { GITHUB_TOKEN: "not-an-object" } })],
    ["T-u4", "settings_secrets", JSON.stringify({ removed: ["bad name"] })], ["T-u5", "settings_mcp", "[]"],
  ]) {
    put(key, kind, value);
    assert.equal(settings.getThreadSettings(slug, key, kind.slice("settings_".length)).unreadable, true, key);
    assert.throws(() => settings.threadSettingsForRun(slug, key), /could not be read/, key);
  }
  await assert.rejects(grants.resolveEgressRunEnv({ meta: { env: {} }, channelId: "C1", target: activeTarget("C1"), thread: { key: "T-u1", ...settings.getThreadSettings(slug, "T-u1", "secrets") } }), /could not be read/);
  // Skills are additions only: an unreadable row just adds nothing.
  put("T-u6", "settings_skills", "{not json");
  assert.deepEqual(settings.threadSettingsForRun(slug, "T-u6").skills, {});
  // Follow channel (an empty write) resets it.
  settings.setThreadSettings(slug, "T-u1", "secrets", {});
  assert.deepEqual(settings.getThreadSettings(slug, "T-u1", "secrets"), {});
});

test("a name hidden in a thread is injected from no scope there", async () => {
  const { patchUserEnv } = await import("../src/config/scoped-env.js");
  await patchUserEnv("U_HIDE_OWNER", { set: { name: "GITHUB_TOKEN", value: "ghp_personal_value_hidden_test_0001" }, actor: "U_HIDE_OWNER" });
  const { channelId, slug } = await channel({ GITHUB_TOKEN: local(GH_CHANNEL) });
  settings.setThreadSettings(slug, "T-hide-all", "secrets", { removed: ["GITHUB_TOKEN"] });
  const meta = { channelId, env: { GITHUB_TOKEN: local(GH_CHANNEL) } };
  for (const target of [activeTarget(channelId), bridgeTarget(channelId)]) {
    const out = await grants.resolveEgressRunEnv({ meta, channelId, authorId: "U_HIDE_OWNER", target, thread: { key: "T-hide-all", ...settings.getThreadSettings(slug, "T-hide-all", "secrets") } });
    assert.equal(out.env.GITHUB_TOKEN, undefined, "neither the channel's nor the author's personal value");
  }
});

test("Composio SDK mode withholds the conversation's session for a thread that chose its own", async () => {
  const { resolveComposioRuntime } = await import("../src/gateway/run-integrations.js");
  const asked = [];
  const resolveSdk = async (request) => { asked.push(request.kind); return { mode: "sdk", url: `https://sdk.example/${request.kind}` }; };
  const out = await resolveComposioRuntime({ mode: "sdk", channelId: "C1", authorId: "U1", threadComposioOverride: true, principalTrusted: false, resolveSdk });
  assert.deepEqual(asked, [], "no channel session is minted for that thread");
  assert.equal(out.shared.source, "none-thread");
  assert.equal(out.shared.endpoint, null);
  const meta = settings.threadConnectionMeta({ composioToken: "channel-token" }, { composioToken: "" });
  assert.equal(meta.threadComposioOverride, true);
  assert.equal(settings.threadConnectionMeta({ composioToken: "channel-token" }, {}).threadComposioOverride, undefined);
});
