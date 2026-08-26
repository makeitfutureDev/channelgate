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

saveSettings({ adminPassword: await hashPassword("runtime-reset-password") });
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("runtime reset is admin-gated and clears only channel engine/model overrides", async () => {
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
  assert.deepEqual(await reset.json(), { ok: true, count: 2 });

  const changed = await getChannelMeta(configured.slug);
  assert.equal(changed.engine, "");
  assert.equal(changed.model, "");
  assert.equal(changed.effort, "high");
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
});

test("Settings UI confirms and calls the channel runtime reset route", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="reset-channel-runtime"/);
  assert.match(html, /Clears every channel's engine and model overrides/);
  assert.match(client, /Reset every channel to gateway defaults\?/);
  assert.match(client, /api\("\/api\/channels\/reset-runtime"/);
  assert.match(client, /await loadConversations\(\)/);
});
