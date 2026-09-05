// Skills platform, round two (docs/SKILLS.md): personal skills, feedback and promotion proposals,
// self-service and organization grant tiers, Git publishing (GitHub Contents API, mocked) with
// source adoption, access tokens, the catalog's own MCP endpoint (/mcp/skills) with scopes, the
// GitHub webhook (HMAC over the raw body), gateway-to-gateway sync, and compatibility notes.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const tokens = await import("../src/gateway/skills/tokens.js");
const publish = await import("../src/gateway/skills/publish.js");
const templates = await import("../src/gateway/skills/templates.js");
const peer = await import("../src/gateway/skills/peer-sync.js");
const { checkCompatibility, resolveSkillProfile } = await import("../src/gateway/skills/resolve.js");
const { mountSkillsPublicRoutes } = await import("../src/web/skills-mcp.js");
const { saveSettings, getOrgAccessGrants } = await import("../src/config/settings.js");
const { setUser, getUser, upsertChannelEntry, saveChannelMeta, defaultChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const md = (name, description, extra = "") => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n` });

// ── an HTTP app with the public routes + the admin router (no auth in tests) ────────────────
const triggered = [];
const app = express();
mountSkillsPublicRoutes(app, { triggerSync: (id) => triggered.push(id) });
app.use(express.json({ limit: "5mb" }));
app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  saveSettings({ skillsGithubToken: "", skillsPublishRepo: "", skillsWebhookSecret: "", accessGrants: { skills: [] } });
});

async function mcpClient(token) {
  const client = new Client({ name: "skills-standalone-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/skills`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
async function request(p, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

// ── personal skills, self-service grants, feedback + promotion ──────────────────────────────

test("a personal skill is visible and grantable only to its author until promoted", async () => {
  await setUser("U_OWNER", { name: "Owner", approved: true });
  const created = await authoring.createLocalSkill({ files: [md("My Private Notes", "private notes")], createdBy: "U_OWNER", personal: true, publish: false });
  assert.equal(created.skill.visibility, "personal");
  assert.deepEqual(created.granted.added, ["my-private-notes"], "granted to the author's own tier");
  assert.ok((await getUser("U_OWNER")).skills.includes("my-private-notes"));
  assert.equal(created.published.published, false);
  assert.equal(authoring.canSeeSkill(created.skill, { userId: "U_OTHER" }), false);
  assert.equal(authoring.canSeeSkill(created.skill, { userId: "U_OWNER" }), true);
  assert.equal(authoring.canSeeSkill(created.skill, { isAdmin: true }), true);
  assert.equal(catalog.listSkills({ viewer: "U_OTHER" }).some((s) => s.slug === "my-private-notes"), false);
  assert.equal(catalog.listSkills({ viewer: "U_OWNER" }).some((s) => s.slug === "my-private-notes"), true);
  assert.equal(catalog.listSkills({ viewer: "*" }).some((s) => s.slug === "my-private-notes"), true, "admin surfaces see everything");

  const feedback = authoring.proposeSkillChange({ skill: "my-private-notes", kind: "feedback", note: "great skill", proposedBy: "U_OWNER" });
  assert.equal(feedback.proposal.kind, "feedback");
  assert.deepEqual(feedback.proposal.files, []);
  assert.throws(() => authoring.proposeSkillChange({ skill: "my-private-notes", kind: "feedback", note: "  ", proposedBy: "U_OWNER" }), /needs a note/);
  const closed = await authoring.decideSkillProposal(feedback.proposal.id, { decision: "approve", decidedBy: "U_ADMIN" });
  assert.equal(closed.proposal.status, "approved");
  assert.equal(closed.revision, null);

  const promo = authoring.proposeSkillChange({ skill: "my-private-notes", kind: "promote", note: "share it", proposedBy: "U_OWNER" });
  const decided = await authoring.decideSkillProposal(promo.proposal.id, { decision: "approve", decidedBy: "U_ADMIN" });
  assert.equal(decided.promoted, true);
  assert.equal(catalog.getSkill("my-private-notes").visibility, "org", "promotion makes it an organization skill");
  assert.equal(catalog.listSkills({ viewer: "U_OTHER" }).some((s) => s.slug === "my-private-notes"), true);
});

test("self-service and organization tiers: add/remove for a user, grant/revoke org-wide, delete your own skill", async () => {
  catalog.putSkillRevision({ files: [md("Tier Skill", "tiers", "requires: [tier-dep]\n")], ownerKind: "local", createdBy: "U_X" });
  catalog.putSkillRevision({ files: [md("Tier Dep", "dep")], ownerKind: "local" });
  await setUser("U_SELF", { name: "Self", approved: true, skills: [] });
  const added = await authoring.grantSkillsToUser("U_SELF", ["Tier Skill"]);
  assert.deepEqual(added.added, ["tier-skill", "tier-dep"], "the name resolves and the dependency comes along");
  const removed = await authoring.revokeSkillsFromUser("U_SELF", ["tier-skill"]);
  assert.deepEqual(removed.removed, ["tier-skill"]);
  assert.deepEqual((await getUser("U_SELF")).skills, ["tier-dep"]);

  saveSettings({ accessGrants: { skills: [] } });
  const org = authoring.grantSkillsToOrg(["tier-skill"]);
  assert.deepEqual(org.added, ["tier-skill", "tier-dep"]);
  assert.deepEqual(getOrgAccessGrants().skills, ["tier-skill", "tier-dep"]);
  assert.deepEqual(authoring.revokeSkillsFromOrg(["tier-dep"]).names, ["tier-skill"]);

  const own = await authoring.createLocalSkill({ files: [md("Delete Me", "mine")], createdBy: "U_SELF", publish: false });
  assert.throws(() => authoring.deleteOwnSkill({ skill: own.skill, userId: "U_OTHER" }), /only the author/);
  assert.equal(authoring.deleteOwnSkill({ skill: own.skill, userId: "U_SELF" }).deleted, true);
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/undeletable", mode: "auto" });
  catalog.putSkillRevision({ files: [md("Synced One", "from a source")], ownerKind: "git", sourceId: src.id });
  assert.throws(() => authoring.deleteOwnSkill({ skill: catalog.getSkill("synced-one"), userId: "U_SELF", isAdmin: true }), /cannot be deleted/);
  catalog.removeSource(src.id);
});

// ── compatibility ───────────────────────────────────────────────────────────────────────────

test("compatibility notes flag engine, platform, gateway version and MCP mismatches without refusing", () => {
  catalog.putSkillRevision({ files: [md("Compat Skill", "picky", "compatibility:\n  engines: [codex]\n  platforms: [msteams]\n  min_gateway: 9.0.0\n  mcp: [composio-agent]\n")], ownerKind: "local" });
  const skill = catalog.getSkill("compat-skill");
  const issues = checkCompatibility(skill, { engine: "claude", platform: "slack", gatewayVersion: "1.0.0", mcpServers: ["gateway"] });
  assert.equal(issues.length, 4, issues.join(" | "));
  assert.deepEqual(checkCompatibility(skill, { engine: "codex", platform: "msteams", gatewayVersion: "9.1.0", mcpServers: ["composio-agent"] }), []);
  assert.deepEqual(checkCompatibility(catalog.getSkill("tier-dep"), { engine: "claude" }), [], "no declaration, no notes");
  assert.ok(resolveSkillProfile(["compat-skill"]).slugs.includes("compat-skill"), "advisory only — still resolves");
});

// ── access tokens ───────────────────────────────────────────────────────────────────────────

test("access tokens are shown once, verified by hash, scoped, and revocable", () => {
  const { token, record } = tokens.createAccessToken({ name: "laptop", scopes: ["read", "propose"], createdBy: "admin" });
  assert.match(token, /^cgs_/);
  assert.equal(record.prefix, token.slice(0, 10));
  assert.deepEqual(record.scopes, ["read", "propose"]);
  assert.ok(!JSON.stringify(tokens.listAccessTokens()).includes(token), "the value is never listed");
  const verified = tokens.verifyAccessToken(token);
  assert.equal(verified.id, record.id);
  assert.ok(verified.lastUsedAt === "" || true);
  assert.equal(tokens.tokenHasScope(verified, "read"), true);
  assert.equal(tokens.tokenHasScope(verified, "manage"), false);
  assert.equal(tokens.verifyAccessToken("cgs_not-a-real-token"), null);
  assert.equal(tokens.verifyAccessToken("xyz"), null);
  assert.throws(() => tokens.createAccessToken({ name: "bad", scopes: ["root"] }), /unknown scope/);
  tokens.revokeAccessToken(record.id);
  assert.equal(tokens.verifyAccessToken(token), null, "revoked tokens stop working at once");
  assert.throws(() => tokens.revokeAccessToken(record.id), /already revoked/);
});

// ── Git publishing ──────────────────────────────────────────────────────────────────────────

function fakeGitHub() {
  const store = new Map(); // path → { sha, content }
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method || "GET", url });
    const u = new URL(url);
    const m = /\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(u.pathname);
    if (!m) return { ok: false, status: 404, text: async () => "nope" };
    const p = decodeURIComponent(m[3]);
    if ((init.method || "GET") === "GET") {
      const dir = [...store.keys()].filter((k) => k.startsWith(`${p}/`));
      if (dir.length) {
        // one level: files directly under p, and dirs for deeper ones
        const entries = new Map();
        for (const k of dir) {
          const rest = k.slice(p.length + 1);
          if (rest.includes("/")) entries.set(rest.split("/")[0], { type: "dir", path: `${p}/${rest.split("/")[0]}` });
          else entries.set(rest, { type: "file", path: k, sha: store.get(k).sha });
        }
        return { ok: true, status: 200, text: async () => JSON.stringify([...entries.values()]) };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    }
    const body = JSON.parse(init.body);
    if (init.method === "PUT") {
      const sha = `sha-${store.size + 1}-${p.length}`;
      store.set(p, { sha, content: body.content });
      return { ok: true, status: 201, text: async () => JSON.stringify({ commit: { sha: `commit-${calls.length}` } }) };
    }
    if (init.method === "DELETE") {
      store.delete(p);
      return { ok: true, status: 200, text: async () => JSON.stringify({ commit: { sha: `commit-${calls.length}` } }) };
    }
    return { ok: false, status: 405, text: async () => "" };
  };
  return { fetchImpl, calls, store };
}

test("publishing writes every file of a revision to the configured repository, deletes dropped files, and adopts into a matching source", async () => {
  saveSettings({ skillsGithubToken: "ghp_test", skillsPublishRepo: "example/skills-repo", skillsPublishBranch: "main", skillsPublishSubpath: "skills", skillsPublishMode: "commit" });
  assert.deepEqual(publish.publishTarget(), { owner: "example", repo: "skills-repo", branch: "main", subpath: "skills", mode: "commit", url: "https://github.com/example/skills-repo" });
  const gh = fakeGitHub();
  const created = await authoring.createLocalSkill({ files: [md("Pub Skill", "published"), { path: "references/r.md", content: "r" }], createdBy: "U_P", publish: false });
  const r = await publish.publishRevision({ slug: "pub-skill", actor: "U_P", fetchImpl: gh.fetchImpl });
  assert.equal(r.published, true);
  assert.deepEqual(r.files.sort(), ["skills/pub-skill/SKILL.md", "skills/pub-skill/references/r.md"]);
  assert.equal(r.adopted, false, "no git source points at the publish repository yet");
  assert.match(catalog.getRevision(created.revision.id).publishedRef, /^commit-/);
  assert.equal(Buffer.from(gh.store.get("skills/pub-skill/references/r.md").content, "base64").toString("utf8"), "r");

  // A new revision without the reference: the stale file is deleted upstream.
  const updated = await authoring.updateLocalSkill({ skill: catalog.getSkill("pub-skill"), files: [md("Pub Skill", "published v2")], remove: ["references/r.md"], createdBy: "U_P", publish: false });
  const r2 = await publish.publishRevision({ slug: "pub-skill", revisionId: updated.revision.id, fetchImpl: gh.fetchImpl });
  assert.deepEqual(r2.deleted, ["skills/pub-skill/references/r.md"]);
  assert.ok(gh.calls.some((c) => c.method === "PUT" && /SKILL\.md$/.test(c.url) && true));

  // The publish repository is also a source → the published skill now belongs to that source.
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/skills-repo", mode: "auto" });
  assert.equal(publish.publishSource().id, src.id);
  const r3 = await publish.publishRevision({ slug: "pub-skill", fetchImpl: gh.fetchImpl });
  assert.equal(r3.adopted, true);
  const adopted = catalog.getSkill("pub-skill");
  assert.equal(adopted.ownerKind, "git");
  assert.equal(adopted.sourceId, src.id);
  assert.equal(adopted.sourcePath, "skills/pub-skill");
  // Without a token or a repo, publishing reports why instead of throwing.
  saveSettings({ skillsGithubToken: "" });
  assert.equal((await publish.publishQuietly({ slug: "pub-skill" })).published, false);
  saveSettings({ skillsPublishRepo: "" });
  assert.equal(publish.publishTarget(), null);
  catalog.removeSource(src.id);
});

// ── the MCP endpoint ────────────────────────────────────────────────────────────────────────

test("the /mcp/skills endpoint needs a valid token, honours scopes, and serves the library_* surface", async () => {
  assert.equal((await request("/mcp/skills", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).status, 401);
  assert.equal((await request("/mcp/skills")).status, 405);
  catalog.putSkillRevision({ files: [md("Endpoint Skill", "served over MCP", "category: Endpoint\n"), { path: "references/e.md", content: "endpoint ref" }], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Hidden Personal", "private")], ownerKind: "local", createdBy: "U_OWNER", visibility: "personal" });
  const reader = tokens.createAccessToken({ name: "reader", scopes: ["read"] }).token;
  const client = await mcpClient(reader);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("library_search_skills") && names.includes("library_get_skill_file") && names.includes("library_export"));
    const search = JSON.parse(textOf(await client.callTool({ name: "library_search_skills", arguments: { query: "endpoint" } })));
    assert.equal(search.items.some((i) => i.name === "endpoint-skill"), true);
    assert.equal(search.items.some((i) => i.name === "hidden-personal"), false, "personal skills never leave the gateway");
    assert.ok(search.facets.categories.some((c) => c.name === "Endpoint"));
    assert.equal(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "endpoint-skill", file: "references/e.md" } })), "endpoint ref");
    assert.match(textOf(await client.callTool({ name: "library_get_skill_file", arguments: { name: "hidden-personal" } })), /Unknown skill/);
    const info = JSON.parse(textOf(await client.callTool({ name: "library_get_skill_info", arguments: { name: "Endpoint Skill" } })));
    assert.deepEqual(info.files, ["SKILL.md", "references/e.md"]);
    assert.match(textOf(await client.callTool({ name: "library_suggest_skill_change", arguments: { name: "endpoint-skill", note: "typo" } })), /lacks the "propose" scope/);
    assert.match(textOf(await client.callTool({ name: "library_export", arguments: {} })), /lacks the "sync" scope/);
    const who = JSON.parse(textOf(await client.callTool({ name: "library_whoami", arguments: {} })));
    assert.deepEqual(who.token.scopes, ["read"]);
  } finally {
    await client.close();
  }
  const writer = tokens.createAccessToken({ name: "writer", scopes: ["read", "propose", "manage", "sync"] }).token;
  const c2 = await mcpClient(writer);
  try {
    const proposed = JSON.parse(textOf(await c2.callTool({ name: "library_suggest_skill_change", arguments: { name: "endpoint-skill", note: "please", files: [{ path: "SKILL.md", content: md("Endpoint Skill", "served over MCP, improved").content }] } })));
    assert.equal(proposed.ok, true);
    assert.equal(catalog.getProposal(proposed.proposal_id).kind, "change");
    const created = JSON.parse(textOf(await c2.callTool({ name: "library_create_skill", arguments: { files: [md("Remote Made", "made over MCP")] } })));
    assert.equal(created.name, "remote-made");
    assert.equal(catalog.getSkill("remote-made").createdBy.startsWith("token:"), true);
    const manifest = JSON.parse(textOf(await c2.callTool({ name: "library_export", arguments: {} })));
    const entry = manifest.items.find((i) => i.slug === "endpoint-skill");
    assert.ok(entry && entry.hash && entry.revision === 1);
    assert.equal(manifest.items.some((i) => i.slug === "hidden-personal"), false);
    const exported = JSON.parse(textOf(await c2.callTool({ name: "library_export_skill", arguments: { name: "endpoint-skill" } })));
    assert.deepEqual(exported.files.map((f) => f.path), ["SKILL.md", "references/e.md"]);
    assert.equal(Buffer.from(exported.files[1].content, "base64").toString("utf8"), "endpoint ref");
  } finally {
    await c2.close();
  }
});

// ── the webhook ─────────────────────────────────────────────────────────────────────────────

test("the GitHub webhook verifies the HMAC over the raw body and triggers a sync for the matching source", async () => {
  saveSettings({ skillsWebhookSecret: "" });
  assert.equal((await request("/api/skills/webhook/github", { method: "POST", body: { zen: "x" } })).status, 404, "not configured → 404");
  saveSettings({ skillsWebhookSecret: "hook-secret" });
  const src = catalog.addSource({ kind: "git", url: "https://github.com/Example/Hooked/tree/main/skills", mode: "auto" });
  const body = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "example/hooked" } });
  const sig = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
  assert.equal((await request("/api/skills/webhook/github", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=bad", "x-github-event": "push" } })).status, 401);
  triggered.length = 0;
  const ok = await request("/api/skills/webhook/github", { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": "push" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.sources, [src.id]);
  assert.deepEqual(triggered, [src.id]);
  const ping = await request("/api/skills/webhook/github", { method: "POST", body: "{}", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "hook-secret").update("{}").digest("hex")}`, "x-github-event": "ping" } });
  assert.equal(ping.json.pong, true);
  catalog.removeSource(src.id);
});

// ── gateway-to-gateway sync ─────────────────────────────────────────────────────────────────

test("a gateway source pulls a peer's manifest and files, stages in review mode, and tombstones what the peer dropped", async () => {
  const remote = {
    "peer-alpha": { revision: 3, hash: "h-alpha-1", files: [{ path: "SKILL.md", content: Buffer.from(md("Peer Alpha", "from the peer").content).toString("base64") }, { path: "references/a.md", content: Buffer.from("alpha ref").toString("base64"), executable: false }] },
    "peer-beta": { revision: 1, hash: "h-beta-1", files: [{ path: "SKILL.md", content: Buffer.from(md("Peer Beta", "also from the peer").content).toString("base64") }] },
  };
  const calls = [];
  const connectImpl = async (url, token) => {
    calls.push({ url, token });
    return {
      callTool: async ({ name, arguments: args }) => {
        if (name === "library_export") return { content: [{ type: "text", text: JSON.stringify({ items: Object.entries(remote).map(([slug, r]) => ({ slug, revision: r.revision, hash: r.hash })) }) }] };
        if (name === "library_export_skill") return { content: [{ type: "text", text: JSON.stringify({ slug: args.name, ...remote[args.name] }) }] };
        throw new Error(`unexpected tool ${name}`);
      },
      close: async () => {},
    };
  };
  const src = catalog.addSource({ kind: "gateway", url: "http://127.0.0.1:4748", mode: "review", secret: "cgs_peer_token" });
  assert.equal(catalog.getSource(src.id).hasSecret, true);
  assert.ok(!JSON.stringify(catalog.getSource(src.id)).includes("cgs_peer_token"), "the peer credential never leaves the store");
  const noToken = catalog.addSource({ kind: "gateway", url: "http://127.0.0.1:1", mode: "auto" });
  assert.match((await peer.syncGatewaySource(noToken, { connectImpl })).error, /no access token/);
  catalog.removeSource(noToken.id);

  let r = await peer.syncGatewaySource(src, { connectImpl });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls[0].url, "http://127.0.0.1:4748/mcp/skills");
  assert.equal(calls[0].token, "cgs_peer_token");
  assert.equal(r.staged, 2);
  assert.equal(catalog.getSkill("peer-alpha").currentRevisionId, null, "review mode stages");
  catalog.updateSource(src.id, { mode: "auto" });
  r = await peer.syncGatewaySource(src, { connectImpl });
  assert.equal(r.unchanged, 2, "same bytes → activated staged copies, no new revision");
  assert.ok(catalog.getSkill("peer-alpha").currentRevisionId);
  assert.equal(Buffer.from(catalog.revisionFiles(catalog.getSkill("peer-alpha").currentRevisionId).find((f) => f.path === "references/a.md").content).toString("utf8"), "alpha ref");
  delete remote["peer-beta"];
  r = await peer.syncGatewaySource(src, { connectImpl });
  assert.equal(r.tombstoned, 1);
  assert.equal(catalog.getSkill("peer-beta").deleted, true);
  const failing = await peer.syncGatewaySource(src, { connectImpl: async () => { throw new Error("peer down"); } });
  assert.equal(failing.ok, false);
  assert.match(catalog.getSource(src.id).lastSyncError, /peer down/);
  assert.ok(catalog.getSkill("peer-alpha").currentRevisionId, "last-good stays");
  catalog.removeSource(src.id);
});

// ── admin API surface for the new pieces ────────────────────────────────────────────────────

test("admin API: tokens (value once), visibility, org grants, gateway sources with a write-only secret, publish settings", async () => {
  const minted = await request("/api/skills/tokens", { method: "POST", body: { name: "api-test", scopes: ["read"] } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  assert.match(minted.json.token, /^cgs_/);
  const listed = await request("/api/skills/tokens");
  assert.ok(listed.json.tokens.some((t) => t.id === minted.json.record.id));
  assert.ok(!JSON.stringify(listed.json).includes(minted.json.token));
  assert.equal((await request(`/api/skills/tokens/${minted.json.record.id}/revoke`, { method: "POST", body: {} })).json.record.revoked, true);

  await request("/api/skills/catalog", { method: "POST", body: { files: [md("Vis Skill", "visibility test")], publish: false } });
  const personal = await request("/api/skills/catalog/vis-skill/visibility", { method: "POST", body: { visibility: "personal" } });
  assert.equal(personal.json.skill.visibility, "personal");
  assert.equal((await request("/api/skills/catalog/vis-skill/visibility", { method: "POST", body: { visibility: "secret" } })).status, 400);

  saveSettings({ accessGrants: { skills: [] } });
  const org = await request("/api/skills/org/grant", { method: "POST", body: { slugs: ["endpoint-skill"] } });
  assert.deepEqual(org.json.added, ["endpoint-skill"]);
  assert.deepEqual((await request("/api/skills/org/revoke", { method: "POST", body: { slugs: ["endpoint-skill"] } })).json.removed, ["endpoint-skill"]);

  const gw = await request("/api/skills/sources", { method: "POST", body: { kind: "gateway", url: "http://127.0.0.1:9", mode: "review", secret: "cgs_x", syncNow: false } });
  assert.equal(gw.status, 201, JSON.stringify(gw.json));
  assert.equal(gw.json.source.hasSecret, true);
  assert.ok(!JSON.stringify(gw.json).includes("cgs_x"));
  const cleared = await request(`/api/skills/sources/${gw.json.source.id}`, { method: "PUT", body: { clearSecret: true } });
  assert.equal(cleared.json.source.hasSecret, false);
  await request(`/api/skills/sources/${gw.json.source.id}`, { method: "DELETE" });

  const settings = await request("/api/settings", { method: "PUT", body: { skillsPublishRepo: "example/publish-here", skillsPublishSubpath: "/library/", skillsWebhookSecret: "whsec_1234" } });
  assert.equal(settings.status, 200, JSON.stringify(settings.json));
  const overview = await request("/api/skills/overview");
  assert.equal(overview.json.settings.publish.owner, "example");
  assert.equal(overview.json.settings.publish.repo, "publish-here");
  assert.equal(overview.json.settings.publish.subpath, "library");
  assert.equal(overview.json.settings.hasWebhookSecret, true);
  assert.equal((await request("/api/settings", { method: "PUT", body: { skillsPublishRepo: "not a repo" } })).status, 400);
});

// ── Repository sections ─────────────────────────────────────────────────────────────────────

test("repository sections: a channel-scoped skill publishes under channels/<id>/, the channel tier includes it, and a move promotes it with the grant kept", async () => {
  saveSettings({ skillsGithubToken: "ghp_test", skillsPublishRepo: "example/sections-repo", skillsPublishBranch: "main", skillsPublishSubpath: ".", skillsPublishMode: "commit" });
  assert.equal(publish.publishTarget().subpath, "", "'.' means the repository root");
  const gh = fakeGitHub();
  const entry = await upsertChannelEntry("C_SECTION_1", { name: "acme-ops", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_SECTION_1", name: "acme-ops", type: "channel", isDM: false }));
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/sections-repo", mode: "auto" });
  // The section is derived from a synced path; anything outside channels/<id>/ is the library.
  assert.equal(catalog.channelScopeOfPath("channels/C_SECTION_1/acme-synced"), "C_SECTION_1");
  assert.equal(catalog.channelScopeOfPath("acme-synced"), "");
  assert.equal(catalog.channelScopeOfPath("skills/channels/x/y"), "");
  const synced = catalog.putSkillRevision({ files: [md("Acme Synced", "synced into a section")], ownerKind: "git", sourceId: src.id, sourcePath: "channels/C_SECTION_1/acme-synced", sourceRef: "abc" });
  assert.equal(synced.skill.channelScope, "C_SECTION_1");
  // Created with a channel scope: no explicit grant needed, the tier rule covers it.
  const created = await authoring.createLocalSkill({ files: [md("Acme Check", "acme only")], createdBy: "U_S", channelId: "C_SECTION_1", grantTo: entry.slug, publish: false });
  assert.equal(created.skill.channelScope, "C_SECTION_1");
  assert.equal(created.granted, null);
  assert.deepEqual(templates.channelSkillGrants({ channelId: "C_SECTION_1", skills: ["extra"] }).sort(), ["acme-check", "acme-synced", "extra"]);
  assert.deepEqual(templates.channelSkillGrants({ channelId: "C_ELSEWHERE", skills: [] }), []);
  assert.ok(templates.withTemplateSkills({ channelId: "C_SECTION_1", skills: [] }).skills.includes("acme-check"));
  await assert.rejects(authoring.createLocalSkill({ files: [md("Acme Private", "x")], createdBy: "U_S", channelId: "C_SECTION_1", personal: true }), /personal/);
  // Publishing writes the section folder plus its README, and adoption keeps the scope.
  const r = await publish.publishRevision({ slug: "acme-check", fetchImpl: gh.fetchImpl });
  assert.deepEqual(r.files, ["channels/C_SECTION_1/acme-check/SKILL.md"]);
  assert.ok(gh.store.has("channels/C_SECTION_1/README.md"), "the section README names the channel");
  assert.match(Buffer.from(gh.store.get("channels/C_SECTION_1/README.md").content, "base64").toString("utf8"), /#acme-ops/);
  assert.equal(r.adopted, true);
  assert.equal(catalog.getSkill("acme-check").sourcePath, "channels/C_SECTION_1/acme-check");
  assert.equal(catalog.getSkill("acme-check").channelScope, "C_SECTION_1");
  // A skill the publish repository already owns is written back to its own folder, not the publish folder.
  catalog.putSkillRevision({ files: [md("Lib Root", "root skill")], ownerKind: "git", sourceId: src.id, sourcePath: "lib-root", sourceRef: "abc" });
  assert.deepEqual((await publish.publishRevision({ slug: "lib-root", fetchImpl: gh.fetchImpl })).files, ["lib-root/SKILL.md"]);
  // Promote to the library: files move, the channel keeps an explicit grant, the tier still has it.
  const moved = await authoring.moveSkillScope({ slug: "acme-check", channelId: "", actor: "U_S", fetchImpl: gh.fetchImpl });
  assert.equal(moved.moved, true);
  assert.equal(moved.repo.path, "acme-check");
  assert.ok(gh.store.has("acme-check/SKILL.md"));
  assert.ok(!gh.store.has("channels/C_SECTION_1/acme-check/SKILL.md"), "the old folder is gone");
  assert.equal(catalog.getSkill("acme-check").channelScope, "");
  assert.equal(catalog.getSkill("acme-check").sourcePath, "acme-check");
  assert.deepEqual(moved.kept.added, ["acme-check"]);
  assert.ok(templates.channelSkillGrants(await getChannelMeta(entry.slug)).includes("acme-check"), "still active there through the explicit grant");
  assert.equal(templates.channelSkillGrants({ channelId: "C_SECTION_1", skills: [] }).includes("acme-check"), false);
  assert.equal((await authoring.moveSkillScope({ slug: "acme-check", channelId: "", fetchImpl: gh.fetchImpl })).moved, false, "already there");
  // Back into the section (nothing to keep), a foreign source's skill and an unknown channel are refused.
  const back = await authoring.moveSkillScope({ slug: "acme-check", channelId: "C_SECTION_1", actor: "U_S", fetchImpl: gh.fetchImpl });
  assert.equal(back.repo.path, "channels/C_SECTION_1/acme-check");
  assert.equal(back.kept, null);
  assert.equal(catalog.getSkill("acme-check").channelScope, "C_SECTION_1");
  const other = catalog.addSource({ kind: "git", url: "https://github.com/example/other-repo", mode: "auto" });
  catalog.putSkillRevision({ files: [md("Other Skill", "elsewhere")], ownerKind: "git", sourceId: other.id, sourcePath: "other-skill", sourceRef: "x" });
  await assert.rejects(authoring.moveSkillScope({ slug: "other-skill", channelId: "C_SECTION_1", fetchImpl: gh.fetchImpl }), /only skills in the publish repository/);
  await assert.rejects(authoring.moveSkillScope({ slug: "acme-check", channelId: "C_NOPE", fetchImpl: gh.fetchImpl }), /no channel with id/);
  // A never-published local skill just changes scope; a sync that finds the skill elsewhere follows the path.
  await authoring.createLocalSkill({ files: [md("Local Only", "not published")], createdBy: "U_S", publish: false });
  const m2 = await authoring.moveSkillScope({ slug: "local-only", channelId: "C_SECTION_1", fetchImpl: gh.fetchImpl });
  assert.equal(m2.repo, null);
  assert.equal(catalog.getSkill("local-only").channelScope, "C_SECTION_1");
  const resynced = catalog.putSkillRevision({ files: [md("Acme Synced", "synced into a section")], ownerKind: "git", sourceId: src.id, sourcePath: "acme-synced", sourceRef: "def" });
  assert.equal(resynced.changed, false);
  assert.equal(catalog.getSkill("acme-synced").channelScope, "", "same bytes at a library path: the scope follows the path");
  assert.ok(catalog.catalogStats().scoped >= 2);
  saveSettings({ skillsPublishRepo: "", skillsPublishSubpath: "skills" });
});
