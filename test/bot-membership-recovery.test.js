import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createBotMembershipRecovery } = await import("../src/slack/bot-membership.js");
const {
  assertChannelMembership, invalidateSlackMembership, confirmSlackMembership, slackMembershipEpoch,
} = await import("../src/gateway/channel-membership.js");
const { handleBotJoinedChannel, handleMemberLeftChannel } = await import("../src/slack/members.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const meta = (channelId, patch = {}) => ({ channelId, type: "channel", isDM: false, instructions: "Preserved", ...patch });
let fixtureCount = 0;
function fixture(t, rows, listing) {
  const prefix = `fixture-${++fixtureCount}-`;
  const stored = new Map(rows.map((row) => [prefix + row.channelId, structuredClone(row)]));
  const calls = [];
  const archived = [];
  const verified = [];
  let connected = true;
  let fetchPage = listing;
  const channels = async () => [...stored].map(([slug, current]) => ({ slug, channelId: current.channelId, meta: structuredClone(current) }));
  const patch = async (slug, change) => {
    const current = stored.get(slug);
    const partial = typeof change === "function" ? change(structuredClone(current)) : change;
    if (!partial) return null;
    const next = { ...current, ...partial };
    stored.set(slug, next);
    return structuredClone(next);
  };
  const client = { users: { conversations: async (args) => { calls.push(args); return fetchPage(args); } } };
  const recovery = createBotMembershipRecovery({
    slack: { getClient: () => connected ? client : null, snapshot: () => ({ connected }) },
    channels, patch, onArchived: (row) => archived.push(row.channelId), onVerified: (result) => verified.push(result),
    log: () => {},
  });
  t.after(() => recovery.stop());
  return {
    recovery, calls, archived, verified, channels, patch,
    read: (id) => stored.get(prefix + id),
    setListing: (next) => { fetchPage = next; },
    setConnected: (next) => { connected = next; },
    entry: (id) => ({ slug: prefix + id, channelId: id }),
  };
}

test("complete bot membership pagination recovers missed removals and rejoins without touching DMs or other platforms", async (t) => {
  const f = fixture(t, [
    meta("C_PRESENT"), meta("G_RETURNED", { type: "group", archived: true, archivedReason: "bot_removed" }),
    meta("G_REMOVED", { type: "group", allowedUsers: ["U_GUEST"] }),
    meta("G_GROUP_DM", { type: "mpim" }),
    meta("D_DIRECT", { type: "im", isDM: true }),
    meta("teams:OTHER", { platform: "msteams" }),
  ], async ({ cursor }) => cursor
    ? { ok: true, channels: [{ id: "G_RETURNED" }, { id: "G_GROUP_DM" }], response_metadata: {} }
    : { ok: true, channels: [{ id: "C_PRESENT" }], response_metadata: { next_cursor: "page-two" } });
  await f.recovery.invalidate();
  assert.equal(f.read("C_PRESENT").botMembership, "pending");
  assert.throws(() => assertChannelMembership(f.read("C_PRESENT")), { code: "channel_membership_unverified" });
  const result = await f.recovery.reconcile();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map((call) => call.cursor || ""), ["", "page-two"]);
  assert.equal(f.calls[0].types, "public_channel,private_channel,mpim");
  assert.equal(f.calls[0].exclude_archived, false);
  assert.equal(f.calls[0].user, undefined, "the listing must use the calling bot's own memberships");
  assert.deepEqual(f.archived, ["G_REMOVED"]);
  assert.equal(f.read("G_REMOVED").archived, true);
  assert.equal(f.read("G_REMOVED").botMembership, "absent");
  assert.deepEqual(f.read("G_REMOVED").allowedUsers, ["U_GUEST"]);
  assert.equal(f.read("G_REMOVED").instructions, "Preserved");
  assert.equal(f.read("G_RETURNED").archived, false);
  assert.equal(f.read("G_RETURNED").archivedReason, null);
  assert.ok(result.restored.includes(f.entry("G_RETURNED").slug));
  assert.equal(f.verified.length, 1);
  assert.doesNotThrow(() => assertChannelMembership(f.read("C_PRESENT")));
  assert.doesNotThrow(() => assertChannelMembership(f.read("G_GROUP_DM")));
  assert.equal(f.read("D_DIRECT").botMembership, undefined);
  assert.equal(f.read("teams:OTHER").botMembership, undefined);
});

test("partial pagination failure leaves every channel pending without falsely archiving private channels", async (t) => {
  const f = fixture(t, [meta("C_PARTIAL"), meta("G_PARTIAL")], async ({ cursor }) => {
    if (cursor) throw Object.assign(new Error("ratelimited"), { retryAfter: 60 });
    return { ok: true, channels: [{ id: "C_PARTIAL" }], response_metadata: { next_cursor: "next" } };
  });
  await f.recovery.invalidate();
  const result = await f.recovery.reconcile();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verification_failed");
  for (const id of ["C_PARTIAL", "G_PARTIAL"]) {
    assert.equal(f.read(id).botMembership, "pending");
    assert.equal(f.read(id).archived, undefined);
    assert.throws(() => assertChannelMembership(f.read(id)), { code: "channel_membership_unverified" });
  }
  assert.deepEqual(f.archived, []);
  assert.deepEqual(f.verified, []);
  f.setListing(async () => ({ ok: true, channels: [{ id: "C_PARTIAL" }, { id: "G_PARTIAL" }] }));
  assert.equal((await f.recovery.reconcile()).ok, true);
  assert.doesNotThrow(() => assertChannelMembership(f.read("G_PARTIAL")));
});

test("missing scope and malformed or cyclic listings never prove nonmembership", async (t) => {
  for (const listing of [
    async () => { throw new Error("missing_scope"); },
    async () => ({ ok: false, error: "invalid_types" }),
    async () => ({}),
    async () => ({ channels: [{ id: "" }] }),
    async () => ({ channels: [], response_metadata: { next_cursor: 12 } }),
    async () => ({ channels: [], response_metadata: { next_cursor: "repeated" } }),
    async () => ({ channels: [], response_metadata: { next_cursor: " repeated " } }),
  ]) {
    const f = fixture(t, [meta("G_UNKNOWN")], listing);
    await f.recovery.invalidate();
    assert.equal((await f.recovery.reconcile()).ok, false);
    assert.equal(f.read("G_UNKNOWN").archived, undefined);
    assert.equal(f.read("G_UNKNOWN").botMembership, "pending");
    assert.deepEqual(f.archived, []);
  }
});

test("disconnect revokes propagation synchronously and supersedes an in-flight snapshot", async (t) => {
  const page = deferred();
  const f = fixture(t, [meta("C_DISCONNECT")], async () => page.promise);
  await f.recovery.invalidate();
  const running = f.recovery.reconcile();
  await tick();
  f.setConnected(false);
  const invalidation = f.recovery.invalidate();
  assert.throws(() => assertChannelMembership(meta("C_DISCONNECT")), { code: "channel_membership_unverified" });
  page.resolve({ channels: [{ id: "C_DISCONNECT" }] });
  assert.equal((await running).reason, "superseded");
  await invalidation;
  assert.equal(f.read("C_DISCONNECT").botMembership, "pending");
  assert.equal((await f.recovery.reconcile()).reason, "disconnected");
  assert.deepEqual(f.verified, []);
});

test("an older snapshot cannot undo a newer bot departure", async (t) => {
  const page = deferred();
  const f = fixture(t, [meta("C_SNAPSHOT_EVENT")], async () => page.promise);
  await f.recovery.invalidate();
  const running = f.recovery.reconcile();
  await tick();
  await handleMemberLeftChannel({ channel: "C_SNAPSHOT_EVENT", user: "U_BOT", event_ts: "1700000010.000001" }, {
    botUserId: "U_BOT", getChannelEntry: async () => f.entry("C_SNAPSHOT_EVENT"), patchChannelMeta: f.patch,
    ensureChannelFolder: async () => assert.fail("departure must not provision"),
  });
  page.resolve({ channels: [{ id: "C_SNAPSHOT_EVENT" }] });
  assert.equal((await running).reason, "superseded");
  assert.equal(f.read("C_SNAPSHOT_EVENT").archived, true);
  assert.equal(f.read("C_SNAPSHOT_EVENT").botMembership, "absent");
  assert.deepEqual(f.verified, []);
});

test("a delayed join initialization cannot undo a newer removal or provision files", async (t) => {
  const initialize = deferred();
  const f = fixture(t, [meta("C_DELAYED_JOIN")], async () => ({ channels: [] }));
  let provisions = 0;
  const joining = handleBotJoinedChannel({ channel: "C_DELAYED_JOIN", event_ts: "1700000020.000001" }, {
    initialize: async () => initialize.promise, patchChannelMeta: f.patch,
    provision: async () => { provisions++; },
  });
  await tick();
  const leaving = handleMemberLeftChannel({ channel: "C_DELAYED_JOIN", user: "U_BOT", event_ts: "1700000021.000001" }, {
    botUserId: "U_BOT", getChannelEntry: async () => f.entry("C_DELAYED_JOIN"), patchChannelMeta: f.patch,
    ensureChannelFolder: async () => assert.fail("departure must not provision"),
  });
  initialize.resolve({ entry: f.entry("C_DELAYED_JOIN"), initialMeta: meta("C_DELAYED_JOIN") });
  assert.equal(await joining, null);
  assert.equal(await leaving, true);
  assert.equal(f.read("C_DELAYED_JOIN").archived, true);
  assert.equal(f.read("C_DELAYED_JOIN").botMembershipEventTs, "1700000021.000001");
  assert.equal(provisions, 0);
});

test("a newer rejoin restores propagation while delayed older membership events are ignored", async (t) => {
  const id = "C_REJOIN_ORDER";
  const f = fixture(t, [meta(id, { archived: true, botMembership: "absent", botMembershipEventTs: "1700000030.000001" })], async () => ({ channels: [] }));
  invalidateSlackMembership();
  let provisions = 0;
  const joinDeps = {
    initialize: async () => ({ entry: f.entry(id), initialMeta: meta(id) }), patchChannelMeta: f.patch,
    provision: async (_entry, current) => { assertChannelMembership(current); provisions++; },
  };
  assert.ok(await handleBotJoinedChannel({ channel: id, event_ts: "1700000032.000001" }, joinDeps));
  assert.equal(f.read(id).archived, false);
  assert.equal(provisions, 1);
  assert.equal(await handleMemberLeftChannel({ channel: id, user: "U_BOT", event_ts: "1700000031.000001" }, {
    botUserId: "U_BOT", getChannelEntry: async () => f.entry(id), patchChannelMeta: f.patch,
    ensureChannelFolder: async () => assert.fail("departure must not provision"),
  }), false);
  assert.equal(await handleBotJoinedChannel({ channel: id, event_ts: "1700000032.000001" }, joinDeps), null);
  assert.equal(provisions, 1);
  assert.equal(f.read(id).archived, false);
  assert.doesNotThrow(() => assertChannelMembership(f.read(id)));
});

test("persisted event ordering survives restart without revoking a valid verified membership", async (t) => {
  const id = "C_DURABLE_ORDER";
  const f = fixture(t, [meta(id, { archived: false, botMembership: "member", botMembershipEventTs: "1700000042.000001" })], async () => ({ channels: [] }));
  invalidateSlackMembership();
  confirmSlackMembership(id, slackMembershipEpoch());
  assert.equal(await handleBotJoinedChannel({ channel: id, event_ts: "1700000041.000001" }, {
    initialize: async () => ({ entry: f.entry(id), initialMeta: meta(id) }), patchChannelMeta: f.patch,
    provision: async () => assert.fail("a durable stale join must not provision"),
  }), null);
  assert.equal(f.read(id).botMembershipEventTs, "1700000042.000001");
  assert.doesNotThrow(() => assertChannelMembership(f.read(id)));
});

test("persisted pending membership blocks real workspace writes until a complete snapshot confirms membership", async (t) => {
  const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, getChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
  const { workspaceFolder } = await import("../src/config/paths.js");
  const { ensureChannelFolder, updateChannelInstructions } = await import("../src/gateway/folders.js");
  const { syncWorkspaceSkills } = await import("../src/gateway/skills/workspace-sync.js");
  const { resolveRuntime } = await import("../src/runtimes/resolve.js");
  const id = "C_PROPAGATION_RECOVERY";
  const entry = await upsertChannelEntry(id, { name: "propagation-recovery", type: "channel", isDM: false });
  const original = { ...defaultChannelMeta({ channelId: id, type: "channel", isDM: false }), instructions: "Recovered instructions" };
  await saveChannelMeta(entry.slug, original);
  const recovery = createBotMembershipRecovery({
    slack: {
      getClient: () => ({ users: { conversations: async () => ({ channels: [{ id }] }) } }),
      snapshot: () => ({ connected: true }),
    },
    channels: async () => [{ ...entry, channelId: id, meta: await getChannelMeta(entry.slug) }],
    patch: patchChannelMeta, log: () => {},
  });
  t.after(() => recovery.stop());
  await recovery.invalidate();
  await assert.rejects(ensureChannelFolder(entry.slug, original), { code: "channel_membership_unverified" });
  await assert.rejects(updateChannelInstructions(entry.slug, original, { text: "Blocked" }), { code: "channel_membership_unverified" });
  assert.throws(() => resolveRuntime(entry.slug, original), { code: "channel_membership_unverified" });
  assert.equal((await syncWorkspaceSkills({ force: false, log: () => {} })).synced.includes(entry.slug), false);
  await assert.rejects(access(workspaceFolder(entry.slug)), { code: "ENOENT" });
  assert.equal((await recovery.reconcile()).ok, true);
  const converged = await syncWorkspaceSkills({ force: false, log: () => {} });
  assert.equal(converged.ok, true);
  assert.ok(converged.synced.includes(entry.slug), "membership confirmation must invalidate the skipped sync fingerprint");
  assert.match(await readFile(path.join(workspaceFolder(entry.slug), "CLAUDE.md"), "utf8"), /Recovered instructions/);
});

test("a stale delivered join cannot revive a channel absent from a complete live membership list", async (t) => {
  const { readBotMemberships } = await import("../src/slack/bot-membership.js");
  const id = "G_STALE_LIVE_JOIN";
  const f = fixture(t, [meta(id, { type: "group", archived: true, botMembership: "absent" })], async () => ({ channels: [] }));
  let initialized = false;
  const result = await handleBotJoinedChannel({ channel: id, event_ts: "1700000050.000001" }, {
    initialize: async () => {
      const memberships = await readBotMemberships({ users: { conversations: async () => ({ channels: [] }) } });
      if (!memberships.has(id)) return null;
      initialized = true;
      return { entry: f.entry(id), initialMeta: meta(id) };
    },
    patchChannelMeta: f.patch,
    provision: async () => assert.fail("historical join must never restart propagation"),
  });
  assert.equal(result, null);
  assert.equal(initialized, false);
  assert.equal(f.read(id).archived, true);
  assert.equal(f.read(id).botMembership, "absent");
});

test("an endless sequence of unique cursors cannot certify a partial membership listing", async (t) => {
  let pages = 0;
  const f = fixture(t, [meta("G_UNBOUNDED")], async () => ({ channels: [], response_metadata: { next_cursor: `page-${++pages}` } }));
  await f.recovery.invalidate();
  assert.equal((await f.recovery.reconcile()).ok, false);
  assert.ok(pages <= 1000, "a bounded reader must give up without exhausting resources");
  assert.equal(f.read("G_UNBOUNDED").archived, undefined);
  assert.equal(f.read("G_UNBOUNDED").botMembership, "pending");
});


test("stale whole-record configuration saves cannot clear lifecycle admission after removal", async () => {
  const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, getChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
  const { ensureChannelFolder } = await import("../src/gateway/folders.js");
  const id = "C_STALE_WHOLE_SAVE";
  const entry = await upsertChannelEntry(id, { name: "stale-save", type: "channel", isDM: false });
  const old = defaultChannelMeta({ channelId: id, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, old);
  const admission = { archived: true, archivedReason: "bot_removed", archivedAt: "2026-11-03T00:00:00Z",
    botMembership: "absent", botMembershipEventTs: "1793664000.000001" };
  await patchChannelMeta(entry.slug, admission);
  await saveChannelMeta(entry.slug, { ...old, memory: false, archived: false, botMembership: "member" });
  const actual = await getChannelMeta(entry.slug);
  for (const [key, value] of Object.entries(admission)) assert.equal(actual[key], value);
  assert.equal(actual.memory, false);
  await assert.rejects(ensureChannelFolder(entry.slug, old), { code: "channel_archived" });
});

test("a failed refresh closes prior verification without falsely archiving a member", async (t) => {
  const id = "C_FAILED_REFRESH";
  const f = fixture(t, [meta(id)], async () => ({ channels: [{ id }] }));
  await f.recovery.invalidate();
  assert.equal((await f.recovery.reconcile()).ok, true);
  assert.doesNotThrow(() => assertChannelMembership(f.read(id)));
  f.setListing(async () => { throw new Error("ratelimited"); });
  assert.equal((await f.recovery.reconcile()).ok, false);
  assert.equal(f.read(id).archived, false);
  assert.equal(f.read(id).botMembership, "pending");
  assert.throws(() => assertChannelMembership(f.read(id)), { code: "channel_membership_unverified" });
});
