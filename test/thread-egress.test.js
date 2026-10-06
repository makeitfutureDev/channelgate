import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const grants = await import("../src/gateway/egress/grants.js");
const { patchChannelEnv } = await import("../src/config/channel-env.js");
const liveness = await import("../src/gateway/egress/liveness.js");
const { canUseGrant } = await import("../src/gateway/egress/service.js");
const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");
const entry = (value) => patchChannelEnv({}, { set: { name: "GITHUB_TOKEN", value } });
const target = { backend: "container", runtime: { capabilities: { isolated: true } }, settings: { egressSecretsStrict: false }, container: { egress: { mode: "proxy", active: true } } };
const deps = { resolveOrgEnv: async () => ({ GITHUB_TOKEN: "organization-token" }), resolveUserEnv: async () => ({ GITHUB_TOKEN: "personal-token" }), orgEntries: () => entry("organization-token"), userEntries: async () => entry("personal-token") };

test("thread environment wins with a separate placeholder, without mutating channel grants or other threads", async () => {
  const meta = { env: entry("channel-token"), threadEnv: entry("thread-token"), threadSettingsKey: "thread-a" };
  const a = await grants.resolveEgressRunEnv({ meta, channelId: "C_THREAD_ENV", authorId: "U_THREAD", target, deps });
  const b = await grants.resolveEgressRunEnv({ meta: { ...meta, threadSettingsKey: "thread-b" }, channelId: "C_THREAD_ENV", authorId: "U_THREAD", target, deps });
  const c = await grants.resolveEgressRunEnv({ meta: { env: meta.env }, channelId: "C_THREAD_ENV", authorId: "U_THREAD", target, deps });
  assert.equal(a.scopes.GITHUB_TOKEN, "thread");
  assert.equal(c.scopes.GITHUB_TOKEN, "channel");
  assert.notEqual(a.env.GITHUB_TOKEN, b.env.GITHUB_TOKEN);
  assert.notEqual(a.env.GITHUB_TOKEN, c.env.GITHUB_TOKEN);
  assert.equal(grants.lookupGrant(a.env.GITHUB_TOKEN).ownerId, "thread-a");
  assert.equal(grants.lookupGrant(a.env.GITHUB_TOKEN).scope, "thread");
  assert.ok(a.realValues.includes("thread-token"));
  const removed = await grants.resolveEgressRunEnv({ meta: { env: meta.env, threadSettingsKey: "thread-a", threadEnvRemoved: ["GITHUB_TOKEN"] }, channelId: "C_THREAD_ENV", authorId: "U_THREAD", target, deps });
  assert.equal(removed.scopes.GITHUB_TOKEN, "personal", "channel removal keeps the author's own fallback");
  assert.equal(grants.lookupGrant(a.env.GITHUB_TOKEN), null);
  assert.ok(grants.lookupGrant(c.env.GITHUB_TOKEN), "other threads still inherit the channel credential");
  assert.ok(grants.lookupGrant(b.env.GITHUB_TOKEN));
  await assert.rejects(grants.resolveEgressRunEnv({ meta: { threadEnv: entry("token") }, target, deps }), /bound thread key/);
});

test("thread live material rotates immediately and revokes only that thread on removal", async () => {
  let env = entry("initial-token");
  const a = grants.placeholderFor({ scope: "thread", channelId: "C_ROTATE", ownerId: "a", secretName: "GITHUB_TOKEN" });
  const b = grants.placeholderFor({ scope: "thread", channelId: "C_ROTATE", ownerId: "b", secretName: "GITHUB_TOKEN" });
  const resolver = { metaFor: async () => ({}), threadSettings: async (_channel, key) => ({ env: key === "a" ? env : entry("other-thread-token") }) };
  assert.equal((await grants.resolveEgressGrant(a, resolver)).value, "initial-token");
  env = entry("rotated-token");
  assert.equal((await grants.resolveEgressGrant(a, resolver)).value, "rotated-token", "thread material does not cache revoked/rotated values");
  env = {};
  assert.equal(await grants.resolveEgressGrant(a, resolver), null);
  assert.equal(grants.lookupGrant(a), null);
  assert.equal((await grants.resolveEgressGrant(b, resolver)).value, "other-thread-token");
  assert.notEqual(grants.placeholderFor({ scope: "thread", channelId: "C_ROTATE", ownerId: "a", secretName: "GITHUB_TOKEN" }), a);
});

test("thread swaps need only that thread live; another thread, unknown-thread job, SSH or editor pauses them", async () => {
  liveness.__resetLiveness();
  const ctx = { channelId: "C_THREAD_LIVE", slug: "thread-live", platform: "slack" };
  const grant = { scope: "thread", channelId: ctx.channelId, owner: "a" };
  assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "thread-not-live" });
  const release = liveness.markLive({ channelId: ctx.channelId, ownerId: "U", kind: "turn", id: "a" });
  try {
    assert.deepEqual(canUseGrant(grant, ctx), { ok: true });
    assert.deepEqual(canUseGrant(grant, { ...ctx, channelId: "C_OTHER" }), { ok: false, reason: "other-channel" });
    for (const details of [{ kind: "turn", id: "b" }, { kind: "job", id: "job" }, { kind: "review", id: "review", threadKey: "b" }]) {
      const other = liveness.markLive({ channelId: ctx.channelId, ownerId: "U", ...details });
      assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "another-thread-active" });
      other();
    }
    const sameJob = liveness.markLive({ channelId: ctx.channelId, kind: "job", id: "same-job", threadKey: "a" });
    assert.deepEqual(canUseGrant(grant, ctx), { ok: true });
    sameJob();
    liveness.__setSshSessionSource(() => [{ channelId: ctx.channelId, userId: "U" }]);
    assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "another-thread-active" });
    liveness.__setSshSessionSource(null);
    const { createEditorLease } = await import("../src/runtimes/container/editor-lease.js");
    const { containerName } = await import("../src/runtimes/container/names.js");
    const lease = createEditorLease({ slug: ctx.slug, container: { name: containerName(ctx) } });
    try { assert.deepEqual(canUseGrant(grant, ctx), { ok: false, reason: "another-thread-active" }); }
    finally { lease.release(); }
  } finally { release(); liveness.__resetLiveness(); }
  assert.deepEqual(canUseGrant({ ...grant, scope: "unknown" }, ctx), { ok: false, reason: "unknown-scope" });
});

test("thread credential note is names-only and explains thread liveness", () => {
  const ph = grants.placeholderFor({ scope: "thread", channelId: "C_NOTE", ownerId: "a", secretName: "GITHUB_TOKEN" });
  const note = channelCredentialsPreamble({ GITHUB_TOKEN: ph }, { scopes: { GITHUB_TOKEN: "thread" }, placeholders: { GITHUB_TOKEN: ph }, hosts: { GITHUB_TOKEN: ["api.github.com"] } });
  assert.match(note, /This thread's variables/);
  assert.match(note, /another-thread-active/);
  assert.ok(!note.includes(ph));
});

test("real thread storage resolves by channel slug and hidden-host approval changes only the intended thread", async () => {
  const store = await import("../src/config/store.js");
  const { getThreadSettings, setThreadSettings } = await import("../src/gateway/thread-settings.js");
  const approvals = await import("../src/gateway/secret-host-approvals.js");
  const channel = await store.upsertChannelEntry("C_THREAD_STORED", { name: "Thread stored", type: "channel", isDM: false, platform: "slack" });
  await store.patchChannelMeta(channel.slug, () => ({ channelId: "C_THREAD_STORED", env: entry("channel-token") }));
  const env = patchChannelEnv({}, { set: { name: "PAY_API_TOKEN", value: "thread-pay-secret-12345" } });
  setThreadSettings(channel.slug, "a", "secrets", { env });
  setThreadSettings(channel.slug, "b", "secrets", { env });
  const ph = grants.placeholderFor({ scope: "thread", channelId: "C_THREAD_STORED", ownerId: "a", secretName: "PAY_API_TOKEN" });
  assert.equal((await grants.resolveEgressGrant(ph)).value, "thread-pay-secret-12345");
  await store.setUser("U_THREAD_ADMIN", { isAdmin: true, approved: true });
  const release = liveness.markLive({ channelId: "C_THREAD_STORED", ownerId: "U_THREAD_ADMIN", kind: "turn", id: "a::agent-id", threadKey: "a" });
  assert.equal(liveness.liveTurnIn("C_THREAD_STORED").threadKey, "a::agent-id", "other scopes keep their existing execution delivery thread");
  const otherTurn = liveness.markLive({ channelId: "C_THREAD_STORED", ownerId: "U_OTHER", kind: "turn", id: "b" });
  const calls = [];
  approvals.__resetSecretHostApprovals();
  approvals.setSecretHostApprovalRequester(async request => { calls.push(request); return { pending: true }; });
  try {
    await approvals.requestSecretHostApprovals([{ secretName: "PAY_API_TOKEN", scope: "thread", owner: "a", host: "pay.example" }], { channelId: "C_THREAD_STORED", slug: channel.slug, hostname: "pay.example" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadKey, "a", "approval follows the secret thread, not the most recent channel turn");
    const action = calls[0].durableAction;
    const base = { status: "executing", channelId: "C_THREAD_STORED", slug: channel.slug, decidedBy: "U_THREAD_ADMIN", action };
    const invalid = await approvals.executeSecretHostApproval({ ...base, action: { ...action, ownerId: "b" } });
    assert.equal(invalid.ok, false, "a mismatch between owning and delivery thread is rejected");
    const stale = await approvals.executeSecretHostApproval({ ...base, action: { ...action, entrySetAt: 1 } });
    assert.equal(stale.ok, false);
    assert.equal((await approvals.executeSecretHostApproval(base)).ok, true);
    assert.deepEqual(getThreadSettings(channel.slug, "a", "secrets").env.PAY_API_TOKEN.approvedHosts, ["pay.example"]);
    assert.equal(getThreadSettings(channel.slug, "b", "secrets").env.PAY_API_TOKEN.approvedHosts, undefined);
    assert.deepEqual((await grants.resolveEgressGrant(ph)).hosts, ["pay.example"], "approval metadata changes are live");
    setThreadSettings(channel.slug, "a", "secrets", {});
    assert.equal(await grants.resolveEgressGrant(ph), null);
  } finally { release(); otherTurn(); approvals.__resetSecretHostApprovals(); }
});

test("a secret removed while its provider resolves never revives the revoked placeholder", async () => {
  const ph = grants.placeholderFor({ scope: "thread", channelId: "C_THREAD_RACE", ownerId: "a", secretName: "GITHUB_TOKEN" });
  const material = await grants.resolveEgressGrant(ph, {
    metaFor: async () => ({}), threadSettings: async () => ({ env: entry("removed-token") }),
    resolveChannelEnv: async () => {
      grants.revokeGrants({ scope: "thread", channelId: "C_THREAD_RACE", ownerId: "a", secretName: "GITHUB_TOKEN" });
      return { GITHUB_TOKEN: "removed-token" };
    },
  });
  assert.equal(material, null);
});

test("thread raw values follow the selected run environment, and strict mode withholds them", async () => {
  const meta = { threadEnv: patchChannelEnv({}, { set: { name: "SMTP_PASSWORD", value: "raw-thread-password" } }), threadSettingsKey: "a" };
  const raw = await grants.resolveEgressRunEnv({ meta, channelId: "C_RAW", target, deps });
  assert.equal(raw.env.SMTP_PASSWORD, "raw-thread-password");
  assert.equal(raw.scopes.SMTP_PASSWORD, "thread");
  assert.ok(raw.unprotected.includes("SMTP_PASSWORD"));
  const strict = await grants.resolveEgressRunEnv({ meta, channelId: "C_RAW", target: { ...target, settings: { egressSecretsStrict: true } }, deps });
  assert.equal(strict.env.SMTP_PASSWORD, undefined);
  assert.ok(strict.withheld.includes("SMTP_PASSWORD"));
});
