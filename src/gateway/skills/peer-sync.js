// Gateway-to-gateway sync: a source of kind `gateway` pulls another ChannelGate's catalog over
// that gateway's MCP endpoint (/mcp/skills) with an access token carrying the `sync` scope. The
// peer's organization skills arrive as synced (owner git, this source) revisions — staged in
// review mode, active in auto mode — with the same tombstone/conflict rules as a git source. A
// second gateway on the same host (a follower tracking a primary) needs nothing more than the URL and a
// token minted on the peer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSource, sourceSecret, putSkillRevision, tombstoneMissingSourceSkills, recordSourceSync, getSkill, effectiveRevisionFor, SkillCatalogError } from "./catalog.js";

function endpointFor(url) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new SkillCatalogError(`a gateway source needs an http(s) URL, got "${url}"`);
  return base.endsWith("/mcp/skills") ? base : `${base}/mcp/skills`;
}

async function connect(url, token) {
  const client = new Client({ name: "channelgate-peer-sync", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function parseText(result) {
  const t = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  try {
    return JSON.parse(t);
  } catch {
    throw new SkillCatalogError(`peer returned a non-JSON reply: ${t.slice(0, 160)}`, { status: 502 });
  }
}

export async function syncGatewaySource(source, { log = () => {}, connectImpl = connect } = {}) {
  const src = getSource(typeof source === "number" ? source : source?.id) || source;
  if (!src) throw new SkillCatalogError("source not found", { status: 404 });
  const stats = { discovered: 0, created: 0, updated: 0, staged: 0, unchanged: 0, tombstoned: 0, conflicts: [], skipped: [], oversized: [] };
  let client = null;
  try {
    const token = sourceSecret(src.id);
    if (!token) throw new SkillCatalogError("this gateway source has no access token (edit the source and paste a token minted on the peer)");
    client = await connectImpl(endpointFor(src.url), token);
    const manifest = parseText(await client.callTool({ name: "library_export", arguments: {} }));
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    stats.discovered = items.length;
    log(`[skills] syncing peer ${src.url}: ${items.length} skill(s)`);
    const present = [];
    for (const item of items) {
      const existing = getSkill(item.slug);
      const current = existing && existing.sourceId === src.id ? effectiveRevisionFor(existing) : null;
      if (existing && existing.sourceId === src.id && current && current.contentHash === item.hash && !existing.deleted) {
        present.push(existing.slug);
        stats.unchanged++;
        continue;
      }
      const exported = parseText(await client.callTool({ name: "library_export_skill", arguments: { name: item.slug } }));
      const files = (exported?.files || []).map((f) => ({ path: f.path, content: Buffer.from(String(f.content || ""), "base64"), executable: Boolean(f.executable) }));
      let r;
      try {
        r = putSkillRevision({ slug: item.slug, files, ownerKind: "git", sourceId: src.id, sourcePath: item.source_path || item.slug, sourceRef: `peer:${item.hash?.slice(0, 12) || ""}`, note: `sync from ${src.url}`, status: src.mode === "auto" ? "active" : "staged" });
      } catch (err) {
        stats.skipped.push({ dir: item.slug, reason: err?.message || String(err) });
        continue;
      }
      if (r.conflict) {
        stats.conflicts.push({ slug: item.slug, reason: r.reason });
        continue;
      }
      present.push(r.skill.slug);
      if (!r.changed) stats.unchanged++;
      else if (r.revision?.status === "staged") stats.staged++;
      else if (r.created) stats.created++;
      else stats.updated++;
    }
    stats.tombstoned = tombstoneMissingSourceSkills(src.id, present);
    recordSourceSync(src.id, { ok: true, ref: "", stats });
    return { ok: true, ...stats };
  } catch (err) {
    const message = err?.message || String(err);
    recordSourceSync(src.id, { ok: false, error: message, stats });
    return { ok: false, error: message, ...stats };
  } finally {
    await client?.close().catch(() => {});
  }
}
