import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
process.env.PATH = `${fileURLToPath(new URL("fixtures/", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta, isAdmin } = await import("../src/config/store.js");
const { addSchedule, listForChannel, updateSchedule, deleteSchedule } = await import("../src/config/schedules.js");
const { authorizedSudoSchedule } = await import("../src/gateway/schedule-sudo.js");
const { register } = await import("../src/mcp/tools/schedules.js");
const { runMessage, setRuntimeResolver, mayEscalate, acquireRunSlot, resetRunSlots } = await import("../src/gateway/run.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { sudoModeMeta } = await import("../src/gateway/modes.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");
const { saveSettings } = await import("../src/config/settings.js");
const { readEvents } = await import("../src/util/logger.js");
const scheduler = await import("../src/gateway/scheduler.js");

const ADMIN = "U_SCHEDULE_ADMIN";
const MEMBER = "U_SCHEDULE_MEMBER";
const CHANNEL = "C_SCHEDULE_SUDO";
const stored = (s) => listForChannel(s.channelId).find((row) => row.id === s.id);
const fixture = (extra = {}) => addSchedule({ channelId: CHANNEL, slug: "schedule-sudo", createdBy: ADMIN,
  cron: "0 9 * * *", prompt: "Inspect the host and report the result.", notify: "none", ...extra });
function tools(authorId = ADMIN) {
  const handlers = new Map();
  register({ registerTool: (name, spec, handler) => handlers.set(name, { spec, handler }) }, {
    channelId: CHANNEL, slug: "schedule-sudo", createdBy: authorId, text: (s) => s,
    requireAdmin: () => isAdmin(authorId),
  });
  return (name, args) => {
    const { spec, handler } = handlers.get(name);
    return handler(z.object(spec.inputSchema).parse(args));
  };
}

test.before(async () => {
  await setUser(ADMIN, { approved: true, isAdmin: true });
  await setUser(MEMBER, { approved: true, isAdmin: false });
  saveSettings({ engineFallback: false, codexEnabled: true, memoryReviewEvery: 0 });
});

test("MCP sudo creation is explicit, admin-owned and restricted to agent tasks", async () => {
  const call = tools();
  assert.match(await call("create_schedule", { in_minutes: 60, prompt: "Ordinary task" }), /scheduled/);
  assert.equal(listForChannel(CHANNEL).at(-1).sudo, false);
  const count = listForChannel(CHANNEL).length;
  assert.match(await tools(MEMBER)("create_schedule", { in_minutes: 60, prompt: "No host", sudo: true }), /Only organization admins/);
  assert.match(await call("create_schedule", { in_minutes: 60, prompt: "Reminder", kind: "reminder", sudo: true }), /ordinary agent task/);
  assert.equal(listForChannel(CHANNEL).length, count);
  assert.match(await call("create_schedule", { in_minutes: 60, prompt: "Explicit host task", sudo: true }), /sudo on the gateway host/);
  const schedule = listForChannel(CHANNEL).at(-1);
  assert.equal(schedule.sudo, true);
  assert.equal(JSON.parse(await call("list_schedules", { id: schedule.id })).sudo, true);
  assert.match(await call("list_schedules", {}), /sudo · gateway host/);
});

test("sudo edits require a current admin, exact prompt and an admin owner", async () => {
  const s = fixture();
  assert.match(await tools(MEMBER)("update_schedule", { id: s.id, sudo: true, expected_prompt: s.prompt }), /Only organization admins/);
  assert.match(await tools()("update_schedule", { id: s.id, sudo: true }), /expected_prompt/);
  assert.match(await tools()("update_schedule", { id: s.id, sudo: true, expected_prompt: "stale" }), /changed or was deleted/);
  assert.equal(stored(s).sudo, false);
  assert.match(await tools()("update_schedule", { id: s.id, sudo: true, expected_prompt: s.prompt }), /^Updated/);
  assert.equal(stored(s).sudo, true);
  assert.match(await tools(MEMBER)("update_schedule", { id: s.id, execution_visibility: "silent" }), /Only organization admins/);
  assert.equal(stored(s).executionVisibility, "visible");
  const memberOwned = fixture({ createdBy: MEMBER });
  assert.match(await tools()("update_schedule", { id: memberOwned.id, sudo: true, expected_prompt: memberOwned.prompt }), /creator must currently/);
  assert.match(await tools()("update_schedule", { id: s.id, sudo: false }), /^Updated/);
  assert.equal(stored(s).sudo, false);
});

test("sudo authority rechecks schedule scope, owner, status, origin and current admin rank", async () => {
  const s = fixture({ sudo: true });
  const args = { id: s.id, channelId: CHANNEL, authorId: ADMIN, origin: "schedule" };
  assert.equal(await authorizedSudoSchedule(args), true);
  for (const patch of [{ id: "missing" }, { channelId: "C_OTHER" }, { authorId: MEMBER }, { origin: "background_agent" }, { untrustedPrincipal: true }]) {
    assert.equal(await authorizedSudoSchedule({ ...args, ...patch }), false);
  }
  for (const patch of [{ enabled: false }, { sudo: false }, { kind: "reminder" }, { loop: true }]) {
    updateSchedule(s.id, patch);
    assert.equal(await authorizedSudoSchedule(args), false);
    updateSchedule(s.id, { enabled: true, sudo: true, kind: "task", loop: false });
  }
  await setUser(ADMIN, { isAdmin: false });
  assert.equal(await authorizedSudoSchedule(args), false);
  assert.match(await tools()("update_schedule", { id: s.id, prompt: "Changed", expected_prompt: s.prompt }), /Only organization admins/);
  await setUser(ADMIN, { isAdmin: true });
  deleteSchedule(s.id);
  assert.equal(await authorizedSudoSchedule(args), false);
});

test("ordinary unattended origins cannot gain bypass through stored sudoMode or a sudo thread proof", () => {
  const args = { meta: { sudoMode: true, adminMode: true }, origin: "schedule", isAdminAuthor: true };
  assert.equal(mayEscalate(args), false);
  assert.equal(mayEscalate({ ...args, sudoSchedule: true }), false);
  assert.equal(mayEscalate({ ...args, meta: sudoModeMeta({}) }), false);
  assert.equal(mayEscalate({ ...args, meta: sudoModeMeta({}), sudoSchedule: true }), true);
});

test("both engines run explicitly authorized sudo tasks on host with bypass and deny revoked or spoofed requests before runtime resolution", async (t) => {
  const fake = createFakeRuntimeBackend();
  const resolved = [];
  setRuntimeResolver((slug, meta, options) => {
    const target = resolveRuntime(slug, meta, options);
    resolved.push(target.backend);
    return target.backend === "host" ? target : fakeTarget(fake, slug, meta, options);
  });
  const client = { chat: { postMessage: async () => ({ ok: true, ts: "1792650000.000100" }) } };
  scheduler.resetSchedulerState();
  scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  t.after(() => { setRuntimeResolver(null); scheduler.resetSchedulerState(); });
  for (const engine of ["claude", "codex"]) {
    const channelId = `${CHANNEL}_${engine}`;
    const entry = await upsertChannelEntry(channelId, { name: `sudo-schedule-${engine}`, type: "channel", platform: "slack" });
    await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "channel", platform: "slack", template: "custom", engine,
      allowedUsers: [ADMIN, MEMBER], access: "approved", allowBash: false, adminMode: false, allowNetwork: false });
    const s = fixture({ channelId, slug: entry.slug, sudo: true });
    const run = (extra = {}) => runMessage({ channelId, authorId: ADMIN, text: s.prompt, threadKey: `sched-${s.id}-${Date.now()}`,
      origin: "schedule", preferCold: true, sudoScheduleId: s.id, ...extra });
    let result;
    await scheduler.runSchedule(s, { deliver: async (_client, delivered) => { result = delivered.result; } });
    assert.ok(result, "the real scheduler delivers the completed sudo engine run");
    assert.equal(result.engine, engine);
    assert.match(result.content, /stub.*reply/i);
    assert.equal(result.runtime.backend, "host");
    const event = readEvents({ limit: 100 }).find((row) => row.event === "run_config" && row.channel === channelId);
    assert.equal(event.dangerouslySkip, true);
    assert.equal(event.sudoSchedule, true);
    const previous = resolved.length;
    await setUser(ADMIN, { isAdmin: false });
    assert.equal((await run()).accessRefused, true);
    await setUser(ADMIN, { isAdmin: true });
    assert.equal((await run({ authorId: MEMBER })).accessRefused, true);
    assert.equal((await run({ untrustedPrincipal: true })).accessRefused, true);
    updateSchedule(s.id, { sudo: false });
    assert.equal((await run()).accessRefused, true);
    assert.equal(resolved.length, previous, "rejected host authority cannot provision or spawn a runtime");
    const ordinary = await run({ sudoScheduleId: "" });
    assert.equal(ordinary.runtime.backend, "container");
    assert.ok(fake.calls.spawn.length > 0);
  }
});

test("admin demotion while a sudo task waits for capacity prevents its engine spawn", async (t) => {
  const previousLimit = process.env.MAX_CONCURRENT_RUNS;
  process.env.MAX_CONCURRENT_RUNS = "1";
  resetRunSlots();
  let spawns = 0;
  setRuntimeResolver((slug, meta, options) => {
    const target = resolveRuntime(slug, meta, options);
    target.runtime = { ...target.runtime, spawn(...args) { spawns += 1; return resolveRuntime(slug, meta, options).runtime.spawn(...args); } };
    return target;
  });
  const release = await acquireRunSlot({ origin: "schedule" });
  t.after(async () => {
    release();
    setRuntimeResolver(null);
    if (previousLimit === undefined) delete process.env.MAX_CONCURRENT_RUNS;
    else process.env.MAX_CONCURRENT_RUNS = previousLimit;
    resetRunSlots();
    await setUser(ADMIN, { isAdmin: true });
  });
  const channelId = "C_QUEUED_SUDO";
  const entry = await upsertChannelEntry(channelId, { name: "queued-sudo-task", type: "channel", platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "channel", platform: "slack", template: "custom", engine: "claude", allowNetwork: false });
  const s = fixture({ channelId, slug: entry.slug, sudo: true });
  let queued;
  const waiting = new Promise((resolve) => { queued = resolve; });
  const run = runMessage({ channelId, authorId: ADMIN, text: s.prompt, threadKey: `sched-${s.id}-queued`, origin: "schedule", sudoScheduleId: s.id,
    onEvent: (event) => { if (event.kind === "run_queued") queued(); } });
  const rejected = assert.rejects(run, /Sudo task authorization was revoked/);
  await waiting;
  await setUser(ADMIN, { isAdmin: false });
  release();
  await rejected;
  assert.equal(spawns, 0, "no cached host authority survives demotion while queued");
});
