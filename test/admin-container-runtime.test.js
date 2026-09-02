// The admin surface for the container runtime (v0.8): the gateway settings card, the per-channel
// runtime pin, and the one credential the feature adds. Driven over the real admin router, because
// the rules that matter here are boundary rules — a bad value must 400 rather than silently fall
// back, and the Claude token must never ride a listing response.
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
  saveSettings({ containerRuntimeEnabled: false, containerDefaultBackend: "host", containerClaudeOauthToken: "" });
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
      containerRuntimeEnabled: true,
      containerDefaultBackend: "container",
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
  assert.equal(s.containerRuntimeEnabled, true);
  assert.equal(s.containerDefaultBackend, "container");
  assert.equal(s.containerCli, "podman");
  assert.equal(s.containerImage, "channelgate/runtime:v3");
  assert.equal(s.containerIdleMinutes, 25);
  assert.equal(s.containerMaxRunning, 3);
  assert.equal(s.containerPidsLimit, 2048);
  assert.equal(s.containerMemory, "2g");
  assert.equal(s.containerCpus, "1.5");
  // And the runtime resolver reads the same snapshot the UI just wrote.
  assert.equal(getContainerRuntime().defaultBackend, "container");
});

test("values that would reach the container CLI's argv are rejected, not sanitized", async () => {
  const before = settingsForApi();
  for (const [body, why] of [
    [{ containerDefaultBackend: "vm" }, "unknown backend"],
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
  for (const key of ["containerDefaultBackend", "containerCli", "containerImage", "containerMemory", "containerCpus", "containerIdleMinutes", "containerMaxRunning", "containerPidsLimit"]) {
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

// ── Per-channel runtime pin ───────────────────────────────────────────────────────────────────

test("the channel meta PUT takes host/container/'' and 400s anything else", async () => {
  const ok = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime: "container" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.meta.runtime, "container");
  assert.equal((await getChannelMeta(entry.slug)).runtime, "container");

  for (const runtime of ["docker", "Container", "vm", 1, true, null]) {
    const bad = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime } });
    assert.equal(bad.status, 400, `runtime=${JSON.stringify(runtime)} must be refused`);
    assert.match(bad.json.error, /runtime must be/);
  }
  // The refusals changed nothing.
  assert.equal((await getChannelMeta(entry.slug)).runtime, "container");

  const cleared = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime: "" } });
  assert.equal(cleared.json.meta.runtime, "");
  // A save that says nothing about the runtime preserves it.
  await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime: "host" } });
  const untouched = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { nudges: true } });
  assert.equal(untouched.json.meta.runtime, "host");
});

test("the DM PUT validates the same way", async () => {
  const bad = await request(`/dms/${DM}`, { method: "PUT", body: { runtime: "vm" } });
  assert.equal(bad.status, 400);
  const ok = await request(`/dms/${DM}`, { method: "PUT", body: { runtime: "container" } });
  assert.equal(ok.status, 200);
  assert.equal((await getChannelMeta(dmEntry.slug)).runtime, "container");
});

test("listings carry the EFFECTIVE runtime beside the pin, so the UI never re-derives precedence", async () => {
  await saveSettings({ containerRuntimeEnabled: true, containerDefaultBackend: "host" });
  await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { runtime: "container", adminMode: false, profile: "custom" } });

  const pinned = (await request("/channels")).json.channels.find((c) => c.channelId === CHANNEL);
  assert.deepEqual(pinned.meta.runtimeEffective, { backend: "container", reason: "channel" });
  assert.deepEqual(decideRuntimeBackend(await getChannelMeta(entry.slug)), pinned.meta.runtimeEffective);

  // The gateway-wide kill switch outranks the pin — and the listing says so.
  await saveSettings({ containerRuntimeEnabled: false });
  const killed = (await request("/channels")).json.channels.find((c) => c.channelId === CHANNEL);
  assert.equal(killed.meta.runtime, "container", "the pin is preserved, not rewritten");
  assert.deepEqual(killed.meta.runtimeEffective, { backend: "host", reason: "disabled" });

  // So does admin mode, which is deliberately unconfined on the host.
  await saveSettings({ containerRuntimeEnabled: true });
  const admin = await request(`/channels/${CHANNEL}/meta`, { method: "PUT", body: { adminMode: true, profile: "custom" } });
  assert.deepEqual(admin.json.meta.runtimeEffective, { backend: "host", reason: "admin-mode" });

  const dms = (await request("/dms")).json.dms.find((d) => d.channelId === DM);
  assert.equal(dms.meta.runtimeEffective.backend, "container");
});

// ── The admin UI ──────────────────────────────────────────────────────────────────────────────

test("the admin UI has a Container runtime card and a per-channel runtime select wired to the API", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  for (const id of ["set-container-enabled", "set-container-default", "set-container-cli", "set-container-image",
    "set-container-idle", "set-container-max", "set-container-pids", "set-container-memory", "set-container-cpus",
    "set-container-claude-token", "clear-container-claude-token", "container-runtime-health"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // The token's own instructions live next to the field — an admin should not have to guess.
  assert.match(html, /claude setup-token/);
  assert.match(html, /class="ch-runtime"/);

  assert.match(client, /containerRuntimeEnabled: document\.getElementById\("set-container-enabled"\)\.checked/);
  assert.match(client, /clearContainerClaudeOauthToken: true/);
  assert.match(client, /revealSecret\("settings", "containerClaudeOauthToken"\)/);
  assert.match(client, /runtime: card\.querySelector\("\.ch-runtime"\)\.value/);
  assert.match(client, /paintContainerRuntimeHealth/);
});

test("/api/health carries the container runtime status through an injected reader", async () => {
  const { createWebApp } = await import("../src/web/app.js");
  const health = { enabled: true, cli: { ok: true, kind: "podman", version: "5.7.0" }, image: { ref: "channelgate/runtime:latest", present: true }, running: 2, socket: { listening: true, path: "/run/x" } };
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
