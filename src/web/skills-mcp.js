import { enterpriseFeatureEnabled, requireEnterpriseFeature } from "../ee/feature-entitlements.js";
// The catalog's own MCP endpoint (`POST /mcp/skills`, Streamable HTTP, stateless) and the GitHub
// webhook (`POST /api/skills/webhook/github`). Both sit OUTSIDE the admin session: the MCP
// endpoint authenticates a bearer ACCESS TOKEN minted in the admin UI (skills/tokens.js — hashed,
// scoped, revocable), the webhook an HMAC signature over the raw body. Neither exposes anything a
// token's scopes do not cover, and neither can reach the admin API.
//
// Tool names keep Skills Manager's `library_*` surface for the read/author subset so a client that
// was set up against it keeps working: laptop Claude Code, Codex, any MCP client, and a PEER
// GATEWAY (skills/peer-sync.js) which uses the `sync` scope's export tools.
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyAccessToken, tokenHasScope } from "../gateway/skills/tokens.js";
import { resolveTokenScope } from "../gateway/skills/token-scope.js";
import { clientKey, createLoginLimiter } from "./security.js";
import { getSkill, listSkills, listCategories, skillBundle, revisionFile, revisionFiles, effectiveRevisionFor, listSources } from "../gateway/skills/catalog.js";
import { fileToApi } from "../gateway/skills/files.js";
import { listTemplateSummaries } from "../gateway/skills/templates.js";
import { createLocalSkill, updateLocalSkill, proposeSkillChange, describeOwner } from "../gateway/skills/authoring.js";
import { getSkillsWebhookSecret } from "../config/settings.js";
import { parseRepoUrl } from "../gateway/skills/git-sync.js";
import { logEvent } from "../util/logger.js";

const MAX_TEXT = 60000;
const text = (s) => ({ content: [{ type: "text", text: String(s ?? "").slice(0, MAX_TEXT) }] });
const json = (v) => text(JSON.stringify(v, null, 2));

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return m ? m[1].trim() : "";
}

function summary(skill) {
  return {
    name: skill.slug,
    display_name: skill.name,
    description: skill.description,
    category: skill.category,
    version: skill.version,
    tags: skill.tags,
    requires: skill.requires,
    owner: describeOwner(skill),
    visibility: skill.visibility,
    updated: skill.updatedAt,
  };
}

// One McpServer per request, scoped to the token that authenticated it and to what that token
// may reach (skills/token-scope.js): a catalog token sees the library and never a personal skill;
// a user token is the person who minted it, resolved live.
export function buildSkillsMcpServer(token, reach = null) {
  requireEnterpriseFeature("skillCatalogMcp");
  const server = new McpServer({ name: "channelgate-skills", version: "1.0.0" });
  const need = (scope) => (tokenHasScope(token, scope) ? null : text(`This token lacks the "${scope}" scope.`));
  const scope = reach || { kind: "catalog", ownerId: "", admin: false, viewer: "", canRead: (s) => Boolean(s) && !s.deleted && s.visibility !== "personal" && Boolean(s.discoverable), canExport: (s) => Boolean(s) && !s.deleted && s.visibility !== "personal", canManage: (s) => Boolean(s) && !s.deleted && s.visibility !== "personal", createOptions: () => ({ personal: false, channelId: "" }) };
  // Who authored what through this token: a user token acts as its owner (their personal skills
  // are theirs, their proposals carry their name); a catalog token is itself.
  const viewer = scope.kind === "user" ? scope.ownerId : `token:${token.id}`;
  const readable = (key) => {
    const skill = getSkill(key);
    return skill && scope.canRead(skill) ? skill : null;
  };

  server.registerTool(
    "library_search_skills",
    { description: "Search the gateway's discoverable skill catalog by name, description, category, tags or source. Returns facets and pagination.", inputSchema: { query: z.string().optional(), category: z.string().optional(), source: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() } },
    async ({ query = "", category = "", source = "", limit = 50, offset = 0 }) => {
      const denied = need("read");
      if (denied) return denied;
      const sources = listSources();
      const sourceRow = source ? sources.find((s) => String(s.id) === source || s.label.toLowerCase() === source.toLowerCase()) : null;
      if (source && !sourceRow) return json({ total: 0, count: 0, offset, has_more: false, next_offset: null, items: [], facets: { categories: [], sources: sources.map((s) => ({ id: s.id, name: s.label || s.url })) } });
      const all = listSkills({ query, category, sourceId: sourceRow?.id ?? null, viewer: scope.viewer, ...(scope.kind === "user" ? {} : { discoverable: true }) }).filter((skill) => scope.canRead(skill)).map(summary);
      const items = all.slice(offset, offset + limit);
      return json({ total: all.length, count: items.length, offset, has_more: offset + items.length < all.length, next_offset: offset + items.length < all.length ? offset + items.length : null, items, facets: { categories: listCategories().map((c) => ({ name: c.category, count: c.count })), sources: sources.map((s) => ({ id: s.id, name: s.label || s.url })) } });
    },
  );

  server.registerTool(
    "library_get_skill_info",
    { description: "Metadata for one skill (no body).", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const denied = need("read");
      if (denied) return denied;
      const skill = readable(name);
      if (!skill) return text(`Unknown skill "${name}".`);
      const rev = effectiveRevisionFor(skill);
      return json({ ...summary(skill), revision: rev?.revisionNo ?? null, files: rev ? revisionFiles(rev.id).map((f) => f.path) : [] });
    },
  );

  server.registerTool(
    "library_get_skill_file",
    { description: "Read a file of a skill (default SKILL.md). Binary files come back as a JSON envelope with base64 content.", inputSchema: { name: z.string(), file: z.string().optional() } },
    async ({ name, file = "SKILL.md" }) => {
      const denied = need("read");
      if (denied) return denied;
      const skill = readable(name);
      if (!skill) return text(`Unknown skill "${name}".`);
      const bundle = skillBundle(skill);
      if (!bundle) return text(`"${skill.slug}" has no approved revision yet.`);
      const f = revisionFile(bundle.revision.id, file);
      if (!f) return text(`File not found: ${file}. Available files: ${bundle.files.map((x) => x.path).join(", ")}`);
      const api = fileToApi(f, { includeContent: true });
      return api.encoding === "base64" ? json({ path: api.path, content_type: api.contentType, encoding: "base64", content: api.content }) : text(api.content);
    },
  );

  server.registerTool(
    "library_list_templates",
    { description: "The gateway's skill templates (Development, Sales, …) and the skills each resolves to.", inputSchema: {} },
    async () => {
      const denied = need("read");
      if (denied) return denied;
      return json({ items: listTemplateSummaries().map((t) => ({ name: t.name, slug: t.slug, description: t.description, skills: t.resolved, categories: t.categories })) });
    },
  );

  server.registerTool(
    "library_whoami",
    { description: "The access token this session authenticated with and its scopes.", inputSchema: {} },
    async () => json({ authenticated: true, token: { id: token.id, name: token.name, kind: scope.kind, owner: scope.kind === "user" ? scope.ownerId : null, admin: scope.kind === "user" ? scope.admin : undefined, scopes: token.scopes, created_at: token.createdAt } }),
  );

  const FILE_INPUT = z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() });

  server.registerTool(
    "library_suggest_skill_change",
    { description: "Propose a change to a skill (changed files + note) or leave feedback (note only). An admin reviews it in the gateway.", inputSchema: { name: z.string(), note: z.string(), files: z.array(FILE_INPUT).optional() } },
    async ({ name, note, files = [] }) => {
      const denied = need("propose");
      if (denied) return denied;
      if (!readable(name)) return text(`Unknown skill "${name}".`);
      try {
        const { proposal } = proposeSkillChange({ skill: name, kind: files.length ? "change" : "feedback", files, note, proposedBy: viewer });
        return json({ ok: true, proposal_id: proposal.id, status: proposal.status });
      } catch (err) {
        return text(`Could not file the proposal: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "library_create_skill",
    { description: "Create a new local skill in the catalog from files (SKILL.md required). A catalog token creates a library skill; a user token creates a PERSONAL skill by default, a channel skill when channel_id names a channel that admits you, an organization skill only for an admin (organization: true).", inputSchema: { slug: z.string().optional(), files: z.array(FILE_INPUT).min(1), note: z.string().optional(), channel_id: z.string().optional(), organization: z.boolean().optional() } },
    async ({ slug = "", files, note = "", channel_id = "", organization = false }) => {
      const denied = need("manage");
      if (denied) return denied;
      try {
        const where = scope.createOptions({ channelId: channel_id, organization });
        const r = await createLocalSkill({ slug, files, note, createdBy: viewer, personal: where.personal, channelId: where.channelId });
        return json({ ok: true, name: r.skill.slug, revision: r.revision.revisionNo, published: r.published?.published || false });
      } catch (err) {
        return text(`Could not create the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "library_update_skill",
    { description: "Publish a new revision of a local skill from partial files (unnamed files are kept).", inputSchema: { name: z.string(), files: z.array(FILE_INPUT).min(1), remove: z.array(z.string()).optional(), note: z.string().optional() } },
    async ({ name, files, remove = [], note = "" }) => {
      const denied = need("manage");
      if (denied) return denied;
      const skill = readable(name);
      if (!skill) return text(`Unknown skill "${name}".`);
      if (!scope.canManage(skill)) return text(`This token cannot change "${skill.slug}": ${skill.visibility === "personal" ? "a personal skill is its author's" : skill.channelScope ? "a channel skill is its members'" : "organization skills are changed by admins"} — propose the change with library_suggest_skill_change.`);
      try {
        const r = await updateLocalSkill({ skill, files, remove, note, createdBy: viewer });
        return json({ ok: true, name: skill.slug, changed: r.changed, revision: r.revision?.revisionNo ?? null, published: r.published?.published || false });
      } catch (err) {
        return text(`Could not update the skill: ${err?.message || err}`);
      }
    },
  );

  // Peer gateways: the manifest of every organization skill's effective revision, then files.
  server.registerTool(
    "library_export",
    { description: "SYNC: manifest of every organization skill (slug, effective revision, content hash) for a peer gateway.", inputSchema: {} },
    async () => {
      const denied = need("sync");
      if (denied) return denied;
      const items = [];
      // The library only: `viewer: ""` lists no personal skill, and a user token (never `sync`)
      // cannot get here at all.
      for (const skill of listSkills({ viewer: "" }).filter((skill) => scope.canExport(skill))) {
        const rev = effectiveRevisionFor(skill);
        if (!rev) continue;
        items.push({ slug: skill.slug, name: skill.name, description: skill.description, revision: rev.revisionNo, hash: rev.contentHash, version: rev.version, category: skill.category, source_path: skill.sourcePath });
      }
      return json({ items, sources: listSources().map((s) => ({ id: s.id, kind: s.kind, label: s.label })) });
    },
  );

  server.registerTool(
    "library_export_skill",
    { description: "SYNC: every file of a skill's effective revision (base64) for a peer gateway.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const denied = need("sync");
      if (denied) return denied;
      const skill = getSkill(name);
      if (!skill || !scope.canExport(skill)) return text(`Unknown skill "${name}".`);
      const bundle = skillBundle(skill);
      if (!bundle) return text(`"${skill.slug}" has no approved revision.`);
      return json({ slug: skill.slug, revision: bundle.revision.revisionNo, hash: bundle.revision.contentHash, files: bundle.files.map((f) => ({ path: f.path, content: f.content.toString("base64"), executable: Boolean(f.executable) })) });
    },
  );

  return server;
}

// Bearer verification runs BEFORE the body is parsed (the endpoint accepts 20 MB), so an
// unauthenticated caller costs a hash lookup and nothing more; bad tokens back off per client with
// the same limiter the login uses. A USER token whose owner can no longer use the catalog
// (de-approved, deleted) answers 403 with the reason instead of acting.
export function skillsMcpAuthGate({ limiter = createLoginLimiter({ freeAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 }) } = {}) {
  return async (req, res, next) => {
    if (!enterpriseFeatureEnabled("skillCatalogMcp")) return res.status(403).json({ error: "Skill catalog MCP requires Enterprise.", code: "enterprise_required" });
    const key = clientKey(req);
    const wait = limiter.retryAfterMs(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: "too many invalid tokens; try again later" });
    }
    const token = verifyAccessToken(bearer(req));
    if (!token) {
      limiter.recordFailure(key);
      return res.status(401).json({ error: "a valid skills access token is required (Authorization: Bearer …)" });
    }
    const reach = await resolveTokenScope(token);
    if (!reach) {
      limiter.recordFailure(key);
      return res.status(403).json({ error: "this user token's owner can no longer use the catalog (not an approved user); the token is dead" });
    }
    limiter.recordSuccess(key);
    req.skillsToken = token;
    req.skillsScope = reach;
    next();
  };
}

// Express handler for the MCP endpoint. Stateless: one server + transport per request.
export function skillsMcpHandler() {
  return async (req, res) => {
    if (!enterpriseFeatureEnabled("skillCatalogMcp")) return res.status(403).json({ error: "Skill catalog MCP requires Enterprise.", code: "enterprise_required" });
    const token = req.skillsToken || verifyAccessToken(bearer(req));
    if (!token) {
      res.status(401).json({ error: "a valid skills access token is required (Authorization: Bearer …)" });
      return;
    }
    const reach = req.skillsScope || (await resolveTokenScope(token));
    if (!reach) {
      res.status(403).json({ error: "this user token's owner can no longer use the catalog (not an approved user); the token is dead" });
      return;
    }
    const server = buildSkillsMcpServer(token, reach);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err?.message || "MCP request failed" });
    }
  };
}

// GitHub push webhook: verify the signature over the RAW body, find the source(s) for the pushed
// repository, and hand the sync to the caller-provided trigger (debounced by the caller).
export function skillsWebhookHandler({ triggerSync }) {
  return (req, res) => {
    const secret = getSkillsWebhookSecret();
    if (!secret) return res.status(404).json({ error: "webhook not configured" });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const given = String(req.headers["x-hub-signature-256"] || "");
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return res.status(401).json({ error: "bad signature" });
    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
    const event = String(req.headers["x-github-event"] || "");
    if (event === "ping") return res.json({ ok: true, pong: true });
    const full = String(payload?.repository?.full_name || "").toLowerCase();
    const matched = listSources().filter((s) => {
      if (s.kind !== "git" || !s.enabled) return false;
      try {
        const p = parseRepoUrl(s.url);
        return `${p.owner}/${p.repo}`.toLowerCase() === full;
      } catch {
        return false;
      }
    });
    logEvent("skill_webhook", { event, repo: full, sources: matched.map((s) => s.id) });
    for (const s of matched) triggerSync(s.id);
    res.json({ ok: true, event, sources: matched.map((s) => s.id) });
  };
}

// Mount both routes on an Express app BEFORE the admin auth middleware.
export function mountSkillsPublicRoutes(app, { triggerSync }) {
  app.post("/api/skills/webhook/github", express.raw({ type: "*/*", limit: "2mb" }), skillsWebhookHandler({ triggerSync }));
  app.post("/mcp/skills", skillsMcpAuthGate(), express.json({ limit: "20mb" }), skillsMcpHandler());
  app.get("/mcp/skills", (_req, res) => res.status(405).json({ error: "POST only (stateless Streamable HTTP)" }));
  app.delete("/mcp/skills", (_req, res) => res.status(405).json({ error: "stateless endpoint" }));
}
