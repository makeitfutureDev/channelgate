// User-level skill catalog tokens (operator decision 2026-11-03) and the narrowed catalog tokens:
//   - a person mints their own token from chat; only they list/revoke it; the HTTP API principal
//     and unapproved users cannot;
//   - over /mcp/skills a user token reaches exactly the owner's live set — organization skills,
//     the skills of channels whose policy admits them, their own personal skills — and never
//     another person's personal skill or an unauthorized channel's section skill; edits follow
//     the chat rules (personal: author; channel: members; organization: admins);
//   - the token dies with the owner's approval;
//   - a catalog token never lists, reads, exports or edits a personal skill;
//   - the bearer is verified before the body is parsed, and bad tokens back off per client.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";

const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const tokens = await import("../src/gateway/skills/tokens.js");
const { resolveTokenScope } = await import("../src/gateway/skills/token-scope.js");
const { mountSkillsPublicRoutes, skillsMcpAuthGate } = await import("../src/web/skills-mcp.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, upsertChannelEntry, saveChannelMeta, defaultChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const { register: registerSkillTools } = await import("../src/mcp/tools/skills.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const md = (name, description) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` });
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");

// ── fixtures: two people, two channels, four skills ──────────────────────────────────────────
await setUser("U_TOK_OWNER", { name: "Owner", approved: true, skills: [] });
await setUser("U_TOK_OTHER", { name: "Other", approved: true, skills: [] });
await setUser("U_TOK_ADMIN", { name: "Admin", approved: true, isAdmin: true, skills: [] });
const mine = await upsertChannelEntry("C_TOK_MINE", { name: "tok-mine", type: "channel", isDM: false });
await saveChannelMeta(mine.slug, { ...defaultChannelMeta({ channelId: "C_TOK_MINE", name: "tok-mine", type: "channel", isDM: false }), access: "approved" });
const theirs = await upsertChannelEntry("C_TOK_THEIRS", { name: "tok-theirs", type: "channel", isDM: false });
await saveChannelMeta(theirs.slug, { ...defaultChannelMeta({ channelId: "C_TOK_THEIRS", name: "tok-theirs", type: "channel", isDM: false }), access: "admins" });

catalog.putSkillRevision({ files: [md("Tok Library", "discoverable library skill")], ownerKind: "local" });
catalog.putSkillRevision({ files: [md("Tok Hidden Library", "non-discoverable library skill")], ownerKind: "local" });
catalog.setSkillDiscoverable("tok-hidden-library", false);
catalog.putSkillRevision({ files: [md("Tok Mine Section", "my channel's section skill")], ownerKind: "local", channelScope: "C_TOK_MINE" });
catalog.putSkillRevision({ files: [md("Tok Theirs Section", "an admins-only channel's section skill")], ownerKind: "local", channelScope: "C_TOK_THEIRS" });
await authoring.createLocalSkill({ files: [md("Tok Owner Private", "owner's personal")], createdBy: "U_TOK_OWNER", personal: true, publish: false });
await authoring.createLocalSkill({ files: [md("Tok Other Private", "someone else's personal")], createdBy: "U_TOK_OTHER", personal: true, publish: false });

const app = express();
mountSkillsPublicRoutes(app, { triggerSync: () => {} });
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); saveSettings({ publicUrl: "" }); });

async function mcpClient(token) {
  const client = new Client({ name: "user-skill-tokens-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/skills`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function searchNames(client) {
  return JSON.parse(textOf(await client.callTool({ name: "library_search_skills", arguments: {} }))).items.map((i) => i.name).sort();
}
function toolsFor(authorId, { channelId = "C_TOK_MINE", slug = mine.slug, trusted = true } = {}) {
  const ctx = ctxFromClaims({ channelId, slug, authorId, threadKey: "1700000000.000001", principalTrusted: trusted, engine: "claude" });
  const map = new Map();
  registerSkillTools({ registerTool: (name, _def, handler) => map.set(name, handler) }, ctx);
  return map;
}

test("a person mints, lists and revokes their own token; the API principal and strangers cannot", async () => {
  saveSettings({ publicUrl: "https://gw.example.test" });
  const owner = toolsFor("U_TOK_OWNER");
  const created = textOf(await owner.get("create_my_skill_token")({ name: "laptop" }));
  const value = /`(cgs_[A-Za-z0-9_-]+)`/.exec(created)?.[1];
  assert.ok(value, "the value is shown once");
  assert.match(created, /https:\/\/gw\.example\.test\/mcp\/skills/);
  const listed = textOf(await owner.get("list_my_skill_tokens")({}));
  assert.match(listed, /\*\*laptop\*\*/);
  const id = Number(/#(\d+) \*\*laptop\*\*/.exec(listed)[1]);
  const record = tokens.getAccessToken(id);
  assert.equal(record.kind, "user");
  assert.equal(record.ownerId, "U_TOK_OWNER");
  assert.deepEqual(record.scopes, ["read", "propose", "manage"], "never sync");
  // Someone else cannot revoke it; the owner can.
  assert.match(textOf(await toolsFor("U_TOK_OTHER").get("revoke_my_skill_token")({ id })), /not found/);
  assert.equal(tokens.getAccessToken(id).revoked, false);
  assert.match(textOf(await owner.get("revoke_my_skill_token")({ id })), /revoked/);
  assert.equal(tokens.getAccessToken(id).revoked, true);
  // The HTTP API principal (untrusted) and an unapproved user mint nothing.
  assert.match(textOf(await toolsFor("U_TOK_OWNER", { trusted: false }).get("create_my_skill_token")({ name: "api" })), /Only an approved person/);
  await setUser("U_TOK_NOBODY", { name: "Nobody", approved: false });
  assert.match(textOf(await toolsFor("U_TOK_NOBODY").get("create_my_skill_token")({ name: "x" })), /Only an approved person/);
  // Capped per person.
  for (let i = 0; i < tokens.MAX_USER_TOKENS; i++) tokens.createUserAccessToken({ ownerId: "U_TOK_CAP", name: `t${i}` });
  assert.throws(() => tokens.createUserAccessToken({ ownerId: "U_TOK_CAP", name: "one more" }), /limit/);
});

test("a user token reaches the owner's live set and nothing else; edits follow the chat rules", async () => {
  const { token } = tokens.createUserAccessToken({ ownerId: "U_TOK_OWNER", name: "reach" });
  const client = await mcpClient(token);
  try {
    const names = await searchNames(client);
    assert.ok(names.includes("tok-library"), "discoverable library skill");
    assert.ok(names.includes("tok-mine-section"), "section skill of a channel that admits the owner");
    assert.ok(names.includes("tok-owner-private"), "own personal skill");
    assert.ok(!names.includes("tok-other-private"), "never another person's personal skill");
    assert.ok(!names.includes("tok-theirs-section"), "not an admins-only channel's section skill");
    assert.ok(!names.includes("tok-hidden-library"), "a non-discoverable library skill is not reachable without a grant");
    assert.match(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "tok-other-private" } })), /Unknown skill/);
    assert.match(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "tok-theirs-section" } })), /Unknown skill/);
    assert.match(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "tok-owner-private" } })), /Tok Owner Private/);
    const who = JSON.parse(textOf(await client.callTool({ name: "library_whoami", arguments: {} })));
    assert.equal(who.token.kind, "user");
    assert.equal(who.token.owner, "U_TOK_OWNER");
    // A grant widens the reach live: granting the hidden library skill to the owner's channel.
    await patchChannelMeta(mine.slug, { skills: ["tok-hidden-library"] });
    assert.ok((await searchNames(client)).includes("tok-hidden-library"));
    // Edits: own personal yes; own channel's section yes; organization no (not an admin); other's personal invisible.
    const own = JSON.parse(textOf(await client.callTool({ name: "library_update_skill", arguments: { name: "tok-owner-private", files: [md("Tok Owner Private", "owner's personal, edited")] } })));
    assert.equal(own.ok, true);
    assert.equal(catalog.getSkill("tok-owner-private").createdBy, "U_TOK_OWNER", "the person, not the token, authored it");
    const section = JSON.parse(textOf(await client.callTool({ name: "library_update_skill", arguments: { name: "tok-mine-section", files: [md("Tok Mine Section", "edited by a member")] } })));
    assert.equal(section.ok, true);
    assert.match(textOf(await client.callTool({ name: "library_update_skill", arguments: { name: "tok-library", files: [md("Tok Library", "x")] } })), /organization skills are changed by admins/);
    assert.match(textOf(await client.callTool({ name: "library_update_skill", arguments: { name: "tok-other-private", files: [md("Tok Other Private", "x")] } })), /Unknown skill/);
    // Create: personal by default, in an admitted channel's section on request, never organization.
    const personal = JSON.parse(textOf(await client.callTool({ name: "library_create_skill", arguments: { files: [md("Tok Made Personal", "from a laptop")] } })));
    assert.equal(catalog.getSkill(personal.name).visibility, "personal");
    assert.equal(catalog.getSkill(personal.name).createdBy, "U_TOK_OWNER");
    const inChannel = JSON.parse(textOf(await client.callTool({ name: "library_create_skill", arguments: { files: [md("Tok Made Section", "for my channel")], channel_id: "C_TOK_MINE" } })));
    assert.equal(catalog.getSkill(inChannel.name).channelScope, "C_TOK_MINE");
    assert.match(textOf(await client.callTool({ name: "library_create_skill", arguments: { files: [md("Tok Made Theirs", "x")], channel_id: "C_TOK_THEIRS" } })), /not admitted/);
    assert.match(textOf(await client.callTool({ name: "library_create_skill", arguments: { files: [md("Tok Made Org", "x")], organization: true } })), /only an admin/);
    // Never the library export.
    assert.match(textOf(await client.callTool({ name: "library_export", arguments: {} })), /lacks the "sync" scope/);
  } finally {
    await client.close();
    await patchChannelMeta(mine.slug, { skills: [] });
  }
});

test("the token dies with the owner's approval and revives with it", async () => {
  const { token } = tokens.createUserAccessToken({ ownerId: "U_TOK_OTHER", name: "mortal" });
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = () => fetch(`${base}/mcp/skills`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await post()).status, 200);
  await setUser("U_TOK_OTHER", { name: "Other", approved: false });
  const dead = await post();
  assert.equal(dead.status, 403);
  assert.match((await dead.json()).error, /no longer use the catalog/);
  await setUser("U_TOK_OTHER", { name: "Other", approved: true });
  assert.equal((await post()).status, 200);
});

test("an admin's user token sees the whole library; the resolver reports the live reach", async () => {
  const { token } = tokens.createUserAccessToken({ ownerId: "U_TOK_ADMIN", name: "admin laptop" });
  const scope = await resolveTokenScope(tokens.verifyAccessToken(token));
  assert.equal(scope.kind, "user");
  assert.equal(scope.admin, true);
  assert.ok(scope.canRead(catalog.getSkill("tok-theirs-section")), "an admin is admitted everywhere");
  assert.ok(scope.canRead(catalog.getSkill("tok-hidden-library")));
  assert.ok(!scope.canRead(catalog.getSkill("tok-other-private")), "but even an admin's token is not another person's personal skill");
  assert.ok(scope.canManage(catalog.getSkill("tok-library")), "an admin edits the organization tier");
});

test("a catalog token never lists, reads, exports or edits a personal skill", async () => {
  const { token } = tokens.createAccessToken({ name: "integration", scopes: ["read", "manage", "sync"] });
  const record = tokens.verifyAccessToken(token);
  assert.equal(record.kind, "catalog");
  const client = await mcpClient(token);
  try {
    const names = await searchNames(client);
    assert.ok(names.includes("tok-library"));
    assert.ok(!names.some((n) => /private|made-personal/.test(n)), "no personal skill in the listing");
    assert.match(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "tok-owner-private" } })), /Unknown skill/);
    assert.match(textOf(await client.callTool({ name: "library_update_skill", arguments: { name: "tok-owner-private", files: [md("Tok Owner Private", "x")] } })), /Unknown skill/);
    const manifest = JSON.parse(textOf(await client.callTool({ name: "library_export", arguments: {} })));
    assert.ok(manifest.items.some((i) => i.slug === "tok-library"));
    assert.ok(manifest.items.some((i) => i.slug === "tok-hidden-library"), "non-discoverable library skills are library content for a peer");
    assert.ok(!manifest.items.some((i) => /private|made-personal/.test(i.slug)));
    assert.match(textOf(await client.callTool({ name: "library_export_skill", arguments: { name: "tok-owner-private" } })), /Unknown skill/);
    const made = JSON.parse(textOf(await client.callTool({ name: "library_create_skill", arguments: { files: [md("Tok Catalog Made", "library skill from an integration")] } })));
    assert.equal(catalog.getSkill(made.name).visibility, "org");
  } finally {
    await client.close();
  }
});

test("the bearer is verified before the body is parsed, and bad tokens back off per client", async () => {
  // A 20 MB-capable parser never runs for an unauthenticated caller: the gate answers first,
  // whatever the body says (here: not even JSON).
  let parsed = false;
  const probe = express();
  probe.post("/mcp/skills", skillsMcpAuthGate({ limiter: { retryAfterMs: () => 0, recordFailure() {}, recordSuccess() {} } }), (req, _res, next) => { parsed = true; next(); }, (_req, res) => res.json({ ok: true }));
  const s2 = await new Promise((resolve) => { const s = probe.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/mcp/skills`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cgs_nope" }, body: "{not json" });
    assert.equal(r.status, 401);
    assert.equal(parsed, false);
  } finally {
    s2.close();
  }
  // The real mount: five free misses per client, then 429 with Retry-After.
  let last;
  for (let i = 0; i < 7; i++) {
    last = await fetch(`${base}/mcp/skills`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer cgs_bad${i}` }, body: "{}" });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) >= 1);
  // A valid token from the same client is held too (the bucket is the client), which is the point.
  const { token } = tokens.createUserAccessToken({ ownerId: "U_TOK_OWNER", name: "after-backoff" });
  const held = await fetch(`${base}/mcp/skills`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(held.status, 429);
});
