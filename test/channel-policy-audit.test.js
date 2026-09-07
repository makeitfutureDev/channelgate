// A channel's meta record IS its security posture. Turning Allow-network on, switching a channel to
// Full access, or repointing its working folder used to persist with ZERO rows in `events` — the
// per-channel environment secrets were audited, the posture that decides what a run can reach was
// not. These tests pin the trail down on all three surfaces that can change it: the admin API, the
// gateway control MCP tools, and the diff helper both share.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

// The admin UI's workDir field (and set_channel_workdir) only accept a directory inside the
// allowlisted root, so pin the root at a scratch dir before anything reads it.
const FS_ROOT = tempDir("cg-audit-root-");
process.env.CG_FS_ROOT = FS_ROOT;
const PROJECT_DIR = path.join(FS_ROOT, "project");
mkdirSync(PROJECT_DIR, { recursive: true });

const { policyDiff, ADMIN_UI_ACTOR } = await import("../src/config/channel-audit.js");
const { readEvents } = await import("../src/util/logger.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const CHANNEL_ID = "C_POLICY_AUDIT";
const ADMIN_ID = "U_POLICY_ADMIN";

await setUser(ADMIN_ID, { name: "Policy Admin", isAdmin: true, approved: true });
const entry = await upsertChannelEntry(CHANNEL_ID, { name: "policy-audit", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: CHANNEL_ID, name: "policy-audit", type: "channel", isDM: false }));

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function request(url, { method = "GET", body } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

const policyEvents = () => readEvents({ limit: 200 }).filter((e) => e.event === "channel_meta_changed" && e.slug === entry.slug);

// ── The diff helper ───────────────────────────────────────────────────────────────────────────

test("policyDiff reports only the policy keys that actually changed", () => {
  const before = { adminMode: false, allowNetwork: false, allowBash: true, engine: "claude", workDir: "" };
  const after = { adminMode: true, allowNetwork: true, allowBash: true, engine: "claude", workDir: "/srv/project" };
  const changes = policyDiff(before, after);
  assert.deepEqual(Object.keys(changes).sort(), ["adminMode", "allowNetwork", "workDir"]);
  assert.deepEqual(changes.allowNetwork, { from: false, to: true });
  assert.deepEqual(changes.workDir, { from: "", to: "/srv/project" });
  assert.equal("allowBash" in changes, false, "an unchanged key must not appear");
  assert.equal("engine" in changes, false);
});

test("policyDiff can never carry a token, an env value, or any other non-policy field", () => {
  const changes = policyDiff(
    { composioToken: "comp_old_1111", toolboxToken: "tb_old", makeToolboxKey: "mk_old", env: { SUPABASE_ACCESS_TOKEN: { value: "sk-old" } }, nudges: false, allowNetwork: false },
    { composioToken: "comp_new_2222", toolboxToken: "tb_new", makeToolboxKey: "mk_new", env: { SUPABASE_ACCESS_TOKEN: { value: "sk-new" } }, nudges: true, allowNetwork: true },
  );
  assert.deepEqual(Object.keys(changes), ["allowNetwork"], "only the allowlisted policy key is diffed");
  const blob = JSON.stringify(changes);
  for (const secret of ["comp_old_1111", "comp_new_2222", "tb_old", "tb_new", "mk_old", "mk_new", "sk-old", "sk-new"]) {
    assert.ok(!blob.includes(secret), `${secret} must never reach an audit row`);
  }
});

test("skills are reported as counts, but a same-size swap is still a change", () => {
  assert.deepEqual(policyDiff({ skills: ["a"] }, { skills: ["a", "b"] }).skills, { from: 1, to: 2 });
  // Swapping one grant for another changes what every future run loads — a count comparison alone
  // would call that no change at all.
  assert.deepEqual(policyDiff({ skills: ["a"] }, { skills: ["b"] }).skills, { from: 1, to: 1 });
  assert.deepEqual(policyDiff({ skills: ["a", "b"] }, { skills: ["b", "a"] }), {}, "reordering is not a change");
});

test("list keys normalize to sorted names, so a reorder is not a change", () => {
  assert.deepEqual(policyDiff({ managers: ["U2", "U1"] }, { managers: ["U1", "U2"] }), {});
  assert.deepEqual(
    policyDiff({ allowedMcps: [{ name: "github", command: "x" }] }, { allowedMcps: [{ name: "github", command: "y" }, { name: "linear" }] }).allowedMcps,
    { from: ["github"], to: ["github", "linear"] },
    "an MCP selection is reported by name — never by its transport/config fields",
  );
});

// ── The admin API ─────────────────────────────────────────────────────────────────────────────

test("a policy change through the API logs exactly one channel_meta_changed with before/after", async () => {
  const before = policyEvents().length;
  const saved = await request(`/channels/${CHANNEL_ID}/meta`, {
    method: "PUT",
    body: { allowNetwork: true, adminMode: true, workDir: PROJECT_DIR },
  });
  assert.equal(saved.response.status, 200);
  assert.equal((await getChannelMeta(entry.slug)).allowNetwork, true);

  const events = policyEvents();
  assert.equal(events.length, before + 1, "exactly one row per save");
  const e = events[0];
  assert.deepEqual(e.keys.sort(), ["adminMode", "allowNetwork", "workDir"], "only the keys that moved");
  assert.deepEqual(e.changes.allowNetwork, { from: false, to: true });
  assert.deepEqual(e.changes.adminMode, { from: false, to: true });
  assert.deepEqual(e.changes.workDir, { from: "", to: PROJECT_DIR });
  assert.equal("access" in e.changes, false, "an unchanged key writes nothing");
  assert.equal("composioToken" in e.changes, false);
  assert.equal(e.actor, ADMIN_UI_ACTOR, "the admin UI authenticates one shared password — no personal identity");
  assert.equal(e.author, ADMIN_UI_ACTOR, "and the principal is in the author column too, so the row is never unattributed");
  assert.equal(e.source, "admin-ui");
  assert.equal(e.channel, CHANNEL_ID);
});

test("a save that changes no policy key writes no audit row at all", async () => {
  const before = policyEvents().length;
  // The UI round-trips the whole form on every save; re-submitting it unchanged must not fill the
  // audit with noise.
  const again = await request(`/channels/${CHANNEL_ID}/meta`, {
    method: "PUT",
    body: { allowNetwork: true, adminMode: true, workDir: PROJECT_DIR, nudges: true },
  });
  assert.equal(again.response.status, 200);
  assert.equal(policyEvents().length, before, "nudges is not a policy key — nothing is logged");
});

test("an environment-secret change stays in its own name-only audit and never duplicates into the policy row", async () => {
  const before = policyEvents().length;
  const set = await request(`/channels/${CHANNEL_ID}/env/SUPABASE_ACCESS_TOKEN`, { method: "PUT", body: { value: "sk-should-never-be-logged" } });
  assert.equal(set.response.status, 200);

  assert.equal(policyEvents().length, before, "an env write is not a policy change");
  const envEvent = readEvents({ limit: 50 }).find((e) => e.event === "channel_env_set" && e.slug === entry.slug);
  assert.ok(envEvent, "the env audit still fires");
  assert.equal(envEvent.name, "SUPABASE_ACCESS_TOKEN");
  assert.ok(!JSON.stringify(readEvents({ limit: 200 })).includes("sk-should-never-be-logged"), "no audit row may carry the value");
});

// ── The MCP twins ─────────────────────────────────────────────────────────────────────────────

test("the MCP set_channel_network handler logs the change with the Slack author", async () => {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: CHANNEL_ID, slug: entry.slug, authorId: ADMIN_ID, threadKey: "1700000000.000100", principalTrusted: true, engine: "claude" });
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);

  const before = policyEvents().length;
  const result = await tools.get("set_channel_network")({ enabled: false });
  assert.match(result.content[0].text, /Network OFF/);
  assert.equal((await getChannelMeta(entry.slug)).allowNetwork, false);

  const events = policyEvents();
  assert.equal(events.length, before + 1);
  const e = events[0];
  assert.deepEqual(e.keys, ["allowNetwork"]);
  assert.deepEqual(e.changes.allowNetwork, { from: true, to: false });
  assert.equal(e.actor, ADMIN_ID, "chat changes name the person who made them");
  assert.equal(e.author, ADMIN_ID, "and land in the author column the audit feed filters by");
  assert.equal(e.source, "mcp");

  // A no-op flip still writes nothing: the diff, not the call, decides.
  const noop = policyEvents().length;
  await tools.get("set_channel_network")({ enabled: false });
  assert.equal(policyEvents().length, noop, "re-setting the same value is not a change");
});

test("the MCP admin-mode and workdir twins are audited too", async () => {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: CHANNEL_ID, slug: entry.slug, authorId: ADMIN_ID, threadKey: "1700000000.000100", principalTrusted: true, engine: "claude" });
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);

  await tools.get("set_channel_admin_mode")({ enabled: false });
  assert.deepEqual(policyEvents()[0].changes.adminMode, { from: true, to: false });

  await tools.get("clear_channel_workdir")({});
  const e = policyEvents()[0];
  assert.deepEqual(e.keys, ["workDir"]);
  assert.deepEqual(e.changes.workDir, { from: PROJECT_DIR, to: "" });
  assert.equal(e.actor, ADMIN_ID);
});


test("web base-mode saves preserve independent options and canonicalize the Worker fallback", async () => {
  const fixture = await upsertChannelEntry("C_MODE_OPTIONS_WEB", { name: "mode-options-web", type: "channel", isDM: false });
  await saveChannelMeta(fixture.slug, { ...defaultChannelMeta({ channelId: "C_MODE_OPTIONS_WEB", name: "mode-options-web", type: "channel" }), autoMode: true, cleanMode: true });
  for (const profile of ["admin", "worker", "admin"]) {
    const result = await request("/channels/C_MODE_OPTIONS_WEB/meta", { method: "PUT", body: { profile } });
    assert.equal(result.response.status, 200);
    const stored = await getChannelMeta(fixture.slug);
    assert.equal(stored.autoMode, true);
    assert.equal(stored.cleanMode, true);
    assert.equal(stored.allowBash, true);
    assert.equal(stored.adminMode, profile === "admin");
  }
  await request("/channels/C_MODE_OPTIONS_WEB/meta", { method: "PUT", body: { profile: "read" } });
  const read = await getChannelMeta(fixture.slug);
  assert.equal(read.autoMode, false);
  assert.equal(read.cleanMode, true);
  assert.equal(read.allowBash, false);
  await request("/channels/C_MODE_OPTIONS_WEB/meta", { method: "PUT", body: { profile: "worker", autoMode: true, cleanMode: false } });
  const auto = await getChannelMeta(fixture.slug);
  assert.equal(auto.autoMode, true);
  assert.equal(auto.cleanMode, false);
});
