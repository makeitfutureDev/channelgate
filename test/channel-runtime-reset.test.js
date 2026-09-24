import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;

const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const { setThreadEngine, setThreadModel, setThreadEffort, setThreadClean, getThreadEngine, getThreadModel, getThreadEffort, getThreadClean } =
  await import("../src/gateway/thread-engine.js");

const configured = await upsertChannelEntry("C_RUNTIME_CONFIGURED", {
  name: "runtime-configured",
  type: "channel",
  isDM: false,
});
const fresh = await upsertChannelEntry("C_RUNTIME_FRESH", {
  name: "runtime-fresh",
  type: "group",
  isDM: false,
});
const dm = await upsertChannelEntry("D_RUNTIME_KEEP", {
  name: "runtime-dm",
  type: "im",
  isDM: true,
});

await saveChannelMeta(configured.slug, {
  ...defaultChannelMeta({ channelId: "C_RUNTIME_CONFIGURED", name: "runtime-configured", type: "channel", isDM: false }),
  engine: "codex",
  model: "gpt-5.4",
  effort: "high",
  access: "admins",
  skills: ["keep-skill"],
  composioToken: "keep-secret",
});
await saveChannelMeta(dm.slug, {
  ...defaultChannelMeta({ channelId: "D_RUNTIME_KEEP", name: "runtime-dm", type: "im", isDM: true }),
  engine: "codex",
  model: "gpt-5.4",
});

// Thread pins: the ones a reset must be able to reach, plus a DM's and a clean flag it must not.
await setThreadEngine(configured.slug, "T1", "codex");
await setThreadModel(configured.slug, "T1", "gpt-5.4");
await setThreadEffort(configured.slug, "T1", "high");
await setThreadClean(configured.slug, "T1", true);
await setThreadModel(fresh.slug, "T2", "opus");
await setThreadEngine(dm.slug, "T3", "codex");
await setThreadModel(dm.slug, "T3", "gpt-5.4");

saveSettings({ adminPassword: await hashPassword("runtime-reset-password") });
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("runtime reset is admin-gated and clears only channel engine/model/effort overrides", async () => {
  const unauthorized = await fetch(`${base}/api/channels/reset-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cg-request": "1" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "runtime-reset-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const reset = await fetch(`${base}/api/channels/reset-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cg-request": "1", cookie },
    body: "{}",
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { ok: true, count: 2, threads: 0 });

  const changed = await getChannelMeta(configured.slug);
  assert.equal(changed.engine, "");
  assert.equal(changed.model, "");
  // Effort is part of the same runtime pick as engine/model, so it resets with them — a channel
  // left on the gateway default model with a hand-chosen effort is the bug this closes.
  assert.equal(changed.effort, "");
  assert.equal(changed.access, "admins");
  assert.deepEqual(changed.skills, ["keep-skill"]);
  assert.equal(changed.composioToken, "keep-secret");

  const initialized = await getChannelMeta(fresh.slug);
  assert.equal(initialized.engine, "");
  assert.equal(initialized.model, "");
  assert.equal(initialized.channelId, "C_RUNTIME_FRESH");
  assert.equal(initialized.access, "approved");
  assert.deepEqual(initialized.allowedUsers, []);

  const unchangedDm = await getChannelMeta(dm.slug);
  assert.equal(unchangedDm.engine, "codex");
  assert.equal(unchangedDm.model, "gpt-5.4");

  // The default scope is channels only — a hand-pinned thread keeps answering on its own runtime,
  // which is why the wider scope below exists.
  assert.equal(await getThreadEngine(configured.slug, "T1"), "codex");
  assert.equal(await getThreadModel(configured.slug, "T1"), "gpt-5.4");
});

test("the wider scope also clears per-thread engine/model/effort pins", async () => {
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "runtime-reset-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const reset = await fetch(`${base}/api/channels/reset-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cg-request": "1", cookie },
    body: JSON.stringify({ includeThreads: true }),
  });
  assert.equal(reset.status, 200);
  // Three pins on the configured channel's thread + one on the fresh channel's; the DM's two and
  // the clean flag are out of scope.
  assert.deepEqual(await reset.json(), { ok: true, count: 2, threads: 4 });

  assert.equal(await getThreadEngine(configured.slug, "T1"), "");
  assert.equal(await getThreadModel(configured.slug, "T1"), "");
  assert.equal(await getThreadEffort(configured.slug, "T1"), "");
  assert.equal(await getThreadModel(fresh.slug, "T2"), "");

  // Thread posture is not runtime: a clean thread must stay clean or its resumed session would
  // suddenly gain tool schemas it never had.
  assert.equal(await getThreadClean(configured.slug, "T1"), true);

  // A DM is skipped here exactly as its channel meta is.
  assert.equal(await getThreadEngine(dm.slug, "T3"), "codex");
  assert.equal(await getThreadModel(dm.slug, "T3"), "gpt-5.4");
});

test("Settings UI confirms and calls the channel runtime reset route", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="reset-channel-runtime"/);
  assert.match(html, /Clears every channel's engine, model and effort overrides/);
  assert.match(html, /per-thread <code>\/model<\/code> pins/);
  assert.match(client, /Reset every channel to gateway defaults\?/);
  assert.match(client, /alternativeLabel: "Channels \+ threads"/);
  assert.match(client, /JSON\.stringify\(\{ includeThreads \}\)/);
  assert.match(client, /api\("\/api\/channels\/reset-runtime"/);
  assert.match(client, /await loadConversations\(\)/);
});
