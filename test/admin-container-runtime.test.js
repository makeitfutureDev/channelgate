// The admin surface for the container runtime: the gateway settings card and the one credential
// it adds. Driven over the real admin router, because the rules that matter here are boundary
// rules — a bad value must 400 rather than silently fall back, and the Claude token must never
// ride a listing response. Since the Linux + containers-only cut (2026-09-03) there is no gateway
// kill switch and no per-channel runtime pin: every channel runs in its container, full stop.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
const { settingsForApi, saveSettings, getContainerRuntime, getContainerClaudeOauthToken } = await import("../src/config/settings.js");
const { readSecret, revealableFields } = await import("../src/web/secrets.js");
const { decideRuntimeBackend } = await import("../src/runtimes/resolve.js");

const CHANNEL = "C_RUNTIME";
const entry = await upsertChannelEntry(CHANNEL, { name: "runtime-admin-test", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: CHANNEL, name: "runtime-admin-test", type: "channel", isDM: false }));

const DM = "D_RUNTIME";
const dmEntry = await upsertChannelEntry(DM, { name: "dm-runtime", type: "im", isDM: true });
await saveChannelMeta(dmEntry.slug, defaultChannelMeta({ channelId: DM, name: "dm-runtime", type: "im", isDM: true }));

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  saveSettings({ containerClaudeOauthToken: "" });
});

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

// ── Gateway settings ──────────────────────────────────────────────────────────────────────────

test("the settings PUT accepts the container keys and reads them back through settingsForApi", async () => {
  const saved = await request("/settings", {
    method: "PUT",
    body: {
      containerCli: "podman",
      containerImage: "channelgate/runtime:v3",
      containerIdleMinutes: 25,
      containerMaxRunning: 3,
      containerPidsLimit: 2048,
      containerMemory: "2g",
      containerCpus: "1.5",
    },
  });
  assert.equal(saved.status, 200);
  const s = settingsForApi();
  assert.equal(s.containerCli, "podman");
  assert.equal(s.containerImage, "channelgate/runtime:v3");
  assert.equal(s.containerIdleMinutes, 25);
  assert.equal(s.containerMaxRunning, 3);
  assert.equal(s.containerPidsLimit, 2048);
  assert.equal(s.containerMemory, "2g");
  assert.equal(s.containerCpus, "1.5");
  // The operator-home grant is a boolean and nothing else: off by default, on only when the admin
  // says so, and a string can neither switch it on nor sneak a path in.
  assert.equal(s.containerFullAccessHome, false);
  assert.equal(getContainerRuntime().fullAccessHome, false);
  const grant = await request("/settings", { method: "PUT", body: { containerFullAccessHome: true } });
  assert.equal(grant.status, 200);
  assert.equal(settingsForApi().containerFullAccessHome, true);
  assert.equal(getContainerRuntime().fullAccessHome, true);
  const smuggled = await request("/settings", { method: "PUT", body: { containerFullAccessHome: "/etc" } });
  assert.equal(smuggled.status, 200);
  assert.equal(settingsForApi().containerFullAccessHome, true, "a non-boolean is ignored, not stored");
  const revoke = await request("/settings", { method: "PUT", body: { containerFullAccessHome: false } });
  assert.equal(revoke.status, 200);
  assert.equal(getContainerRuntime().fullAccessHome, false);
  // And the runtime reads the same snapshot the UI just wrote.
  assert.equal(getContainerRuntime().image, "channelgate/runtime:v3");
  assert.equal(getContainerRuntime().cli, "podman");
  // The retired switch and default-backend keys are neither stored nor served.
  const retired = await request("/settings", { method: "PUT", body: { containerRuntimeEnabled: false, containerDefaultBackend: "host" } });
  assert.equal(retired.status, 200);
  assert.equal("containerRuntimeEnabled" in settingsForApi(), false);
  assert.equal("containerDefaultBackend" in settingsForApi(), false);
});

test("values that would reach the container CLI's argv are rejected, not sanitized", async () => {
  const before = settingsForApi();
  for (const [body, why] of [
    [{ containerCli: "nerdctl" }, "unlisted CLI"],
    [{ containerImage: "runtime:latest --privileged" }, "a flag smuggled into the image ref"],
    [{ containerImage: "runtime; rm -rf /" }, "shell metacharacters"],
    [{ containerMemory: "2g --cap-add=ALL" }, "a flag smuggled into the memory limit"],
    [{ containerCpus: "1.5; id" }, "shell metacharacters in cpus"],
    [{ containerIdleMinutes: 0 }, "an out-of-range interval"],
    [{ containerMaxRunning: 9_999 }, "an out-of-range count"],
    [{ containerPidsLimit: 1 }, "an out-of-range pids limit"],
  ]) {
    const r = await request("/settings", { method: "PUT", body });
    assert.equal(r.status, 400, why);
    assert.ok(r.json.error, why);
  }
  // Nothing partial was written by any of the refusals.
  const after_ = settingsForApi();
  for (const key of ["containerCli", "containerImage", "containerMemory", "containerCpus", "containerIdleMinutes", "containerMaxRunning", "containerPidsLimit"]) {
    assert.equal(after_[key], before[key], key);
  }
});

test("blank memory/cpus/image are accepted as 'no limit' / 'the default image'", async () => {
  const r = await request("/settings", { method: "PUT", body: { containerMemory: "", containerCpus: "", containerImage: "" } });
  assert.equal(r.status, 200);
  const s = settingsForApi();
  assert.equal(s.containerMemory, "");
  assert.equal(s.containerCpus, "");
  assert.equal(s.containerImage, "channelgate/runtime:latest");
});

// ── The one credential the feature adds ───────────────────────────────────────────────────────

test("the Claude container token is write-only: has*/last4 on every listing, value only via reveal", async () => {
  const saved = await request("/settings", { method: "PUT", body: { containerClaudeOauthToken: "sk-ant-oat-container-9876" } });
  assert.equal(saved.status, 200);
  const listed = await request("/settings");
  const body = JSON.stringify(listed.json);
  assert.ok(!body.includes("sk-ant-oat-container-9876"), "the token must never ride a listing response");
  assert.equal(listed.json.hasContainerClaudeOauthToken, true);
  assert.equal(listed.json.containerClaudeOauthTokenLast4, "9876");
  assert.equal(listed.json.containerClaudeOauthToken, undefined);

  // Named-getter allowlist, re-authenticated and audited at the route (src/web/secrets.js).
  assert.ok(revealableFields("settings").includes("containerClaudeOauthToken"));
  assert.equal(await readSecret({ scope: "settings", field: "containerClaudeOauthToken" }), "sk-ant-oat-container-9876");
  // The spawn-time getter and the listing agree.
  assert.equal(getContainerClaudeOauthToken(), "sk-ant-oat-container-9876");

  // An unrelated save keeps it; an explicit clear removes it.
  await request("/settings", { method: "PUT", body: { containerIdleMinutes: 11 } });
  assert.equal(getContainerClaudeOauthToken(), "sk-ant-oat-container-9876");
  await request("/settings", { method: "PUT", body: { clearContainerClaudeOauthToken: true } });
  assert.equal(getContainerClaudeOauthToken(), "");
  assert.equal(settingsForApi().hasContainerClaudeOauthToken, false);
});

// ── No per-channel runtime pin ────────────────────────────────────────────────────────────────

test("the retired runtime pin is ignored by the meta and DM PUTs, and every channel resolves to its container", async () => {
  // An older UI (or a hand-written client) may still send `runtime`; the save succeeds and the
  // value is simply not honoured — there is nothing it could select any more.
  for (const runtime of ["host", "container", "vm", "", 1, null]) {
    const r = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime, nudges: true } });
    assert.equal(r.status, 200, `runtime=${JSON.stringify(runtime)} is ignored, not refused`);
    assert.equal(r.json.meta.runtimeEffective, undefined, "listings no longer carry an effective-runtime field");
  }
  assert.notEqual((await getChannelMeta(entry.slug)).runtime, "host");
  const dm = await request(`/dms/${DM}`, { method: "PUT", body: { runtime: "host" } });
  assert.equal(dm.status, 200);
  assert.notEqual((await getChannelMeta(dmEntry.slug)).runtime, "host");

  // The one door the admin API and the MCP tools ask "where does this channel run?" through always
  // answers the container — for a plain channel AND for an admin-mode one (admin mode is the trust
  // the bind-mounted work folder carries, not a way onto the daemon's host).
  assert.deepEqual(decideRuntimeBackend(await getChannelMeta(entry.slug)), { backend: "container", reason: "only-runtime" });
  const admin = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { adminMode: true, profile: "custom" } });
  assert.equal(admin.status, 200);
  assert.equal(admin.json.meta.adminMode, true);
  assert.deepEqual(decideRuntimeBackend(await getChannelMeta(entry.slug)), { backend: "container", reason: "only-runtime" });
  await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { adminMode: false } });

  const listed = (await request("/channels")).json.channels.find((c) => c.channelId === CHANNEL);
  assert.equal(listed.meta.runtimeEffective, undefined);
  const dms = (await request("/dms")).json.dms.find((d) => d.channelId === DM);
  assert.equal(dms.meta.runtimeEffective, undefined);
});

// ── The admin UI ──────────────────────────────────────────────────────────────────────────────

test("the admin UI has a Container runtime card wired to the API, and no switch or per-channel pin", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  for (const id of ["set-container-cli", "set-container-image",
    "set-container-idle", "set-container-max", "set-container-pids", "set-container-memory", "set-container-cpus",
    "set-container-full-access-home",
    "container-runtime-health"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /ANTHROPIC_API_KEY/);
  assert.match(html, /subscription logins and setup-token values are no longer relayed/);
  // The kill switch, the default-backend select and the per-channel runtime select are gone from
  // the markup — and the client must not read them either (a save that queried a removed select
  // would throw before it ever reached the API).
  for (const gone of ["set-container-enabled", "set-container-default", "ch-runtime", "set-container-claude-token", "clear-container-claude-token"]) {
    assert.doesNotMatch(html, new RegExp(gone), gone);
    assert.doesNotMatch(client, new RegExp(gone), gone);
  }
  assert.doesNotMatch(client, /containerRuntimeEnabled|containerDefaultBackend/);

  assert.match(client, /containerFullAccessHome: document\.getElementById\("set-container-full-access-home"\)\.checked/);
  assert.match(client, /set-container-full-access-home"\)\.checked = s\.containerFullAccessHome === true/);
  assert.doesNotMatch(client, /clearContainerClaudeOauthToken: true/);
  assert.doesNotMatch(client, /revealSecret\("settings", "containerClaudeOauthToken"\)/);
  assert.match(client, /paintContainerRuntimeHealth/);

  // Containers-only since the host sandbox was retired: the card must not still describe itself as
  // an alternative to a host sandbox, nor claim admin-mode channels run outside their container.
  assert.doesNotMatch(html, /host sandbox/);
  assert.doesNotMatch(html, /stay on the host/);
  assert.match(html, /Admin-mode channels run in their container too/);
});

test("/api/health carries the container runtime status through an injected reader", async () => {
  const { createWebApp } = await import("../src/web/app.js");
  const health = { cli: { ok: true, kind: "podman", version: "5.7.0" }, image: { ref: "channelgate/runtime:latest", present: true }, running: 2, socket: { listening: true, path: "/run/x" } };
  const healthApp = createWebApp({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) }, containerRuntimeStatus: async () => health });
  const listener = await new Promise((resolve) => {
    const instance = healthApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    // Unauthenticated liveness stays minimal: host tooling is reconnaissance.
    const anonymous = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/health`)).json();
    assert.equal(anonymous.containerRuntime, undefined);
    // With the loopback internal secret (the same identity the updater uses), the field is served.
    const identified = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/health`, { headers: { "x-cg-secret": process.env.CG_APPROVAL_SECRET } })).json();
    assert.deepEqual(identified.containerRuntime, health);
  } finally {
    listener.close();
  }
});

test("a container status reader that throws degrades to a reason instead of a 500", async () => {
  const { createWebApp } = await import("../src/web/app.js");
  const healthApp = createWebApp({
    slack: { snapshot: () => ({ status: "disconnected", connected: false }) },
    containerRuntimeStatus: async () => { throw new Error("podman socket is gone"); },
  });
  const listener = await new Promise((resolve) => {
    const instance = healthApp.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const body = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/health`, { headers: { "x-cg-secret": process.env.CG_APPROVAL_SECRET } })).json();
    assert.equal(body.ok, true);
    assert.equal(body.containerRuntime.ok, false);
    assert.match(body.containerRuntime.reason, /podman socket is gone/);
  } finally {
    listener.close();
  }
});
