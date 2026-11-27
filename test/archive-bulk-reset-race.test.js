import test, { after } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { defaultChannelMeta, getChannelMeta, patchChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
const { onConfigChange } = await import("../src/config/change-events.js");
const { getDefaultChannelAccess } = await import("../src/config/settings.js");
const { workspaceFolder } = await import("../src/config/paths.js");
const { setThreadModel, getThreadModel } = await import("../src/gateway/thread-engine.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
after(() => new Promise((resolve) => server.close(resolve)));

async function channel(id) {
  const name = id.toLowerCase();
  const entry = await upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, {
    ...defaultChannelMeta({ channelId: id, name, type: "channel", isDM: false }),
    access: "admins", manageAccess: "users", managers: ["U_MANAGER"], allowedUsers: ["U_GUEST"],
    engine: "codex", model: "gpt-5.4", effort: "high",
  });
  return entry;
}

async function reset(kind, body = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/channels/reset-${kind}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

// Config-change listeners run between the route's awaited store operations. This deterministically
// reproduces a Slack removal landing after listChannels() but before the next channel is reset.
for (const kind of ["access", "runtime"]) {
  test(`bulk ${kind} reset preserves a removal committed after its channel snapshot`, async () => {
    const first = await channel(`C_RACE_${kind.toUpperCase()}_FIRST`);
    const removed = await channel(`C_RACE_${kind.toUpperCase()}_REMOVED`);
    await setThreadModel(removed.slug, "T_KEEP", "gpt-5.4");
    let armed = true;
    let removal;
    let removedEvents = 0;
    const off = onConfigChange((change) => {
      if (change.slug === removed.slug) removedEvents++;
      if (!armed || change.slug !== first.slug) return;
      armed = false;
      removal = patchChannelMeta(removed.slug, { archived: true, archivedReason: "bot_removed" });
    });
    try {
      const result = await reset(kind, { includeThreads: true });
      await removal;
      assert.equal(armed, false, "the concurrent removal was injected");
      assert.equal(result.count, 1, "only the active channel was reset");
      const meta = await getChannelMeta(removed.slug);
      assert.equal(meta.archived, true);
      assert.equal(meta.archivedReason, "bot_removed");
      assert.equal(meta.access, "admins");
      assert.deepEqual(meta.allowedUsers, ["U_GUEST"]);
      assert.deepEqual(meta.managers, ["U_MANAGER"]);
      assert.equal(meta.engine, "codex");
      assert.equal(meta.model, "gpt-5.4");
      assert.equal(meta.effort, "high");
      assert.equal(removedEvents, 1, "the reset does not write archived metadata");
      assert.equal(await getThreadModel(removed.slug, "T_KEEP"), "gpt-5.4");
      await assert.rejects(access(workspaceFolder(removed.slug)), { code: "ENOENT" });
    } finally {
      off();
      await patchChannelMeta(first.slug, { archived: true });
      await patchChannelMeta(removed.slug, { archived: true });
    }
  });
}

for (const kind of ["access", "runtime"]) {
  test(`${kind} reset succeeds when removal follows its commit and precedes follow-up writes`, async () => {
    const removed = await channel(`C_RACE_AFTER_${kind.toUpperCase()}_COMMIT`);
    await setThreadModel(removed.slug, "T_KEEP", "gpt-5.4");
    let armed = true;
    let removal;
    const off = onConfigChange((change) => {
      if (!armed || change.slug !== removed.slug) return;
      armed = false;
      removal = patchChannelMeta(removed.slug, { archived: true, archivedReason: "bot_removed" });
    });
    try {
      const result = await reset(kind, { includeThreads: true });
      await removal;
      assert.equal(armed, false);
      assert.equal(result.count, 1, "the change committed before removal counts as one reset");
      assert.equal((await getChannelMeta(removed.slug)).archived, true);
      assert.equal(await getThreadModel(removed.slug, "T_KEEP"), "gpt-5.4");
      if (kind === "runtime") assert.equal(result.threads, 0);
      await assert.rejects(access(workspaceFolder(removed.slug)), { code: "ENOENT" });
    } finally {
      off();
      await patchChannelMeta(removed.slug, { archived: true });
    }
  });
}

test("access reset preserves unrelated metadata committed after its channel snapshot", async () => {
  const first = await channel("C_RACE_ACCESS_UNRELATED_FIRST");
  const changed = await channel("C_RACE_ACCESS_UNRELATED_CHANGED");
  let armed = true;
  let concurrent;
  const off = onConfigChange((change) => {
    if (!armed || change.slug !== first.slug) return;
    armed = false;
    concurrent = patchChannelMeta(changed.slug, { instructions: "New instructions from a concurrent admin" });
  });
  try {
    const result = await reset("access");
    await concurrent;
    assert.equal(armed, false);
    assert.equal(result.count, 2);
    const meta = await getChannelMeta(changed.slug);
    assert.equal(meta.instructions, "New instructions from a concurrent admin");
    assert.equal(meta.access, getDefaultChannelAccess());
    assert.equal(meta.manageAccess, "admins");
    assert.deepEqual(meta.managers, []);
    assert.deepEqual(meta.allowedUsers, []);
  } finally {
    off();
    await patchChannelMeta(first.slug, { archived: true });
    await patchChannelMeta(changed.slug, { archived: true });
  }
});
