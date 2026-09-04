// The Skills view of the admin UI: the local skill catalog (browse, read, author, pin/rollback,
// remove), the review queue (staged source revisions + proposals), sources (GitHub / folder,
// sync, settings), templates (edit, preview and apply to a conversation) and usage. Talks to
// src/web/routes/skills.js. No framework — one delegated click handler per panel.
import { api } from "./admin-api.js";
import { confirmDialog, escapeHtml as esc } from "./admin-view.js";

const state = {
  tab: "catalog",
  overview: null,
  catalog: null,
  profiles: null,
  selected: "",
  detail: null,
  fileView: null,
  query: "",
  owner: "",
  showRemoved: false,
  newSkill: false,
  editTemplate: null,
  usageChannel: "",
  usageDays: 30,
  usage: null,
  templatePreview: null,
  applyTemplate: "",
  applyChannel: "",
  applyMode: "add",
  newToken: null,
  message: "",
  error: "",
  wired: false,
};

const body = () => document.getElementById("skills-body");
const fmtWhen = (ts) => (ts ? String(ts).replace("T", " ").slice(0, 16) : "—");
const ownerLabel = (s) => (s.ownerKind === "git" ? `git source #${s.sourceId}` : s.ownerKind);

function setMessage(msg, isError = false) {
  state.message = isError ? "" : msg;
  state.error = isError ? msg : "";
}

async function withStatus(fn, okMessage = "") {
  try {
    const out = await fn();
    setMessage(okMessage);
    return out;
  } catch (err) {
    setMessage(err?.message || String(err), true);
    return null;
  }
}

// ── data ────────────────────────────────────────────────────────────────────────────────────

async function refreshAll() {
  const [overview, catalog, profiles] = await Promise.all([
    api("/api/skills/overview"),
    api(`/api/skills/catalog?q=${encodeURIComponent(state.query)}${state.owner ? `&owner=${encodeURIComponent(state.owner)}` : ""}${state.showRemoved ? "&deleted=1" : ""}`),
    api("/api/skills/profiles"),
  ]);
  state.overview = overview;
  state.catalog = catalog;
  state.profiles = profiles.profiles;
  if (state.selected) await loadDetail(state.selected).catch(() => { state.selected = ""; state.detail = null; });
}

async function loadDetail(slug) {
  state.detail = await api(`/api/skills/catalog/${encodeURIComponent(slug)}`);
  state.selected = state.detail.skill.slug;
  state.fileView = null;
}

export async function loadSkills() {
  wire();
  try {
    await refreshAll();
  } catch (err) {
    body().innerHTML = `<p class="skills-error">Could not load the skills platform: ${esc(err?.message || err)}</p>`;
    return;
  }
  render();
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────

function render() {
  renderSummary();
  const badge = document.getElementById("skills-review-badge");
  const pending = (state.overview?.staged?.length || 0) + (state.overview?.proposals?.length || 0);
  badge.hidden = pending === 0;
  badge.textContent = String(pending);
  for (const b of document.querySelectorAll(".skills-tab")) b.classList.toggle("active", b.dataset.tab === state.tab);
  const status = state.error ? `<p class="skills-error">${esc(state.error)}</p>` : state.message ? `<p class="skills-ok">${esc(state.message)}</p>` : "";
  const panel = { catalog: renderCatalog, review: renderReview, sources: renderSources, templates: renderTemplates, usage: renderUsage }[state.tab] || renderCatalog;
  body().innerHTML = status + panel();
}

function renderSummary() {
  const st = state.overview?.stats || {};
  const el = document.getElementById("skills-summary");
  const stat = (n, label, warn = false) => `<span class="stat${warn ? " warn" : ""}"><b>${esc(String(n ?? 0))}</b>${esc(label)}</span>`;
  el.innerHTML = [
    stat(st.skills, "skills"),
    stat(st.sources, "sources", st.sourceErrors > 0),
    stat(st.templates, "templates"),
    stat(st.staged, "staged for review", st.staged > 0),
    stat(st.pendingProposals, "pending proposals", st.pendingProposals > 0),
    stat(st.usage30d, "uses in 30 days"),
    st.tombstoned ? stat(st.tombstoned, "removed") : "",
    st.excluded ? stat(st.excluded, "excluded") : "",
    stat((state.overview?.orgSkills || []).length, "organization-wide"),
  ].join("");
}

function renderCatalog() {
  const skills = state.catalog?.skills || [];
  const cats = state.catalog?.categories || [];
  const owners = ["", "bundled", "local", "folder", "git"];
  const rows = skills.map((s) => `
    <tr class="clickable${s.slug === state.selected ? " selected" : ""}" data-action="select" data-slug="${esc(s.slug)}">
      <td><code>${esc(s.slug)}</code>${s.visibility === "personal" ? ' <span class="pill">personal</span>' : ""}${s.excluded ? ' <span class="pill">excluded</span>' : s.deleted ? ' <span class="pill">removed</span>' : ""}${s.pinnedRevisionId ? ' <span class="pill">pinned</span>' : ""}${s.stagedCount ? ` <span class="pill">${s.stagedCount} staged</span>` : ""}${s.currentRevisionId == null && !s.deleted ? ' <span class="pill">not active</span>' : ""}</td>
      <td class="desc">${esc(s.description)}</td>
      <td>${esc(s.category || "—")}</td>
      <td><span class="muted">${esc(ownerLabel(s))}</span></td>
      <td>${esc(s.version || "—")}</td>
      <td class="num">${s.usage30d?.total || 0}</td>
    </tr>`).join("");
  return `
    <div class="skills-toolbar">
      <input type="search" id="skills-q" placeholder="Search slug, name, description, tags…" value="${esc(state.query)}" />
      <select id="skills-owner">${owners.map((o) => `<option value="${o}"${o === state.owner ? " selected" : ""}>${o ? esc(o) : "every owner"}</option>`).join("")}</select>
      <label class="skills-inline"><input type="checkbox" id="skills-removed"${state.showRemoved ? " checked" : ""}/> show removed</label>
      <span class="spacer"></span>
      <button type="button" class="ghost" data-action="new-skill">+ New skill</button>
    </div>
    ${cats.length ? `<p class="skills-note">Categories: ${cats.map((c) => `${esc(c.category)} (${c.count})`).join(", ")}</p>` : ""}
    ${state.newSkill ? renderNewSkillForm() : ""}
    <table class="skills-table">
      <thead><tr><th>Skill</th><th>Description</th><th>Category</th><th>Owner</th><th>Version</th><th>Uses 30d</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">No skills yet. Add a GitHub source under Sources, re-import the host folders, or create one here.</td></tr>`}</tbody>
    </table>
    ${state.detail && state.detail.skill.slug === state.selected ? renderDetail() : ""}`;
}

function renderNewSkillForm() {
  return `
    <div class="card skills-detail">
      <h3>New local skill</h3>
      <div class="skills-form">
        <label class="field"><span>Slug (folder name; empty = from the frontmatter name)</span><input id="ns-slug" placeholder="customer-record" /></label>
        <label class="field"><span>Note</span><input id="ns-note" placeholder="why this skill exists" /></label>
        <label class="field wide"><span>SKILL.md</span><textarea id="ns-skill">---
name: my-skill
description: >-
  What this skill does and WHEN to use it — this text is always in context.
category: General
version: 1.0.0
---

# My skill

Step-by-step instructions.
</textarea></label>
        <label class="field"><span>Extra file path (optional)</span><input id="ns-extra-path" placeholder="references/ids.md" /></label>
        <label class="field wide"><span>Extra file content</span><textarea id="ns-extra" style="min-height:100px"></textarea></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-new-skill">Create skill</button><button type="button" class="ghost" data-action="cancel-new-skill">Cancel</button></div>
    </div>`;
}

function renderDetail() {
  const d = state.detail;
  const s = d.skill;
  const channels = state.profiles || [];
  const files = d.files.map((f) => `<span class="skills-chip${state.fileView?.path === f.path ? " active" : ""}"><a href="#" data-action="view-file" data-path="${esc(f.path)}">${esc(f.path)}</a> <span class="muted">${f.size} B${f.executable ? " · exec" : ""}</span></span>`).join("");
  const revs = d.revisions.map((r) => {
    const isEffective = r.id === d.effectiveRevisionId;
    const isPinned = s.pinnedRevisionId === r.id;
    return `<span class="skills-chip${isEffective ? " active" : ""}">#${r.revisionNo} ${esc(r.status)}${r.version ? ` v${esc(r.version)}` : ""} <span class="muted">${fmtWhen(r.createdAt)}${r.sourceRef ? ` · ${esc(r.sourceRef.slice(0, 12))}` : ""}</span>
      ${r.status === "active" && !isPinned ? `<button type="button" data-action="pin" data-rev="${r.revisionNo}" title="Pin this revision (rollback)">pin</button>` : ""}
      ${r.status === "staged" ? `<button type="button" data-action="approve-rev" data-id="${r.id}">approve</button><button type="button" data-action="reject-rev" data-id="${r.id}">reject</button>` : ""}
    </span>`;
  }).join("");
  const usage = d.usage ? `${d.usage.total} use(s) in 90 days (${d.usage.exact} exact, ${d.usage.inferred} inferred), last ${fmtWhen(d.usage.lastTs)}` : "no use recorded in 90 days";
  return `
    <div class="card skills-detail">
      <div class="card-head"><h3><code>${esc(s.slug)}</code> ${esc(s.name !== s.slug ? s.name : "")}</h3><span class="badge">${esc(s.owner)}</span>${s.excluded ? '<span class="badge" title="Excluded by an admin; stays out across syncs until restored">excluded</span>' : s.deleted ? '<span class="badge" title="Dropped by its source; comes back if the source delivers it again">removed</span>' : ""}</div>
      <p class="skills-note">${esc(s.description)}</p>
      <p class="skills-note">Category: ${esc(s.category || "—")} · Version: ${esc(s.version || "—")} · Tags: ${esc((s.tags || []).join(", ") || "—")} · Requires: ${esc((s.requires || []).join(", ") || "—")}${s.createdBy ? ` · Author: ${esc(s.createdBy)}` : ""}</p>
      <p class="skills-note">${esc(usage)}</p>
      <div><strong>Files</strong> (effective revision)</div>
      <div class="files">${files || '<span class="skills-muted">no approved revision yet</span>'}</div>
      ${state.fileView ? `<pre>${esc(state.fileView.content)}</pre>` : ""}
      <div><strong>Revisions</strong>${s.pinnedRevisionId ? ' — pinned <button type="button" class="ghost" data-action="unpin">follow current</button>' : ""}</div>
      <div class="revs">${revs}</div>
      <div class="skills-actions">
        <span class="skills-inline">Grant to
          <select id="grant-channel">${channels.map((c) => `<option value="${esc(c.slug)}">${esc(c.name || c.slug)}${c.skills.includes(s.slug) ? " ✓" : ""}</option>`).join("")}</select>
          <button type="button" class="ghost" data-action="grant">Grant</button>
        </span>
        ${s.ownerKind === "local" ? `<button type="button" class="ghost" data-action="toggle-visibility">${s.visibility === "personal" ? "Make organization skill" : "Make personal (author only)"}</button>` : ""}
        ${(state.overview?.orgSkills || []).some((x) => x.toLowerCase() === s.slug.toLowerCase()) ? `<button type="button" class="ghost" data-action="org-revoke">Remove organization-wide grant</button>` : `<button type="button" class="ghost" data-action="org-grant">Grant organization-wide</button>`}
        ${state.overview?.settings?.publish && s.ownerKind === "local" ? `<button type="button" class="ghost" data-action="publish-now">Publish to Git now</button>` : ""}
        ${s.deleted ? `<button type="button" class="ghost" data-action="restore">Restore</button>` : `<button type="button" class="ghost" data-action="remove">Remove from catalog</button>`}
        <button type="button" class="ghost" data-action="close-detail">Close</button>
      </div>
    </div>`;
}

function renderReview() {
  const staged = state.overview?.staged || [];
  const proposals = state.overview?.proposals || [];
  const stagedRows = staged.map((r) => `
    <tr>
      <td><code>${esc(r.slug)}</code> <span class="muted">${esc(r.skillName || "")}</span></td>
      <td>#${r.revisionNo}${r.version ? ` v${esc(r.version)}` : ""} · ${r.fileCount} file(s)</td>
      <td class="muted">${esc(r.ownerKind === "git" ? `git source #${r.sourceId}` : r.ownerKind)} · ${esc(r.sourceRef.slice(0, 12))}</td>
      <td class="muted">${fmtWhen(r.createdAt)}</td>
      <td><span class="skills-inline"><button type="button" class="ghost" data-action="view-rev" data-id="${r.id}">files</button><button type="button" data-action="approve-rev" data-id="${r.id}">Approve</button><button type="button" class="ghost" data-action="reject-rev" data-id="${r.id}">Reject</button></span></td>
    </tr>`).join("");
  const proposalRows = proposals.map((p) => `
    <tr>
      <td>#${p.id} <code>${esc(p.slug)}</code> <span class="pill">${esc(p.kind)}</span></td>
      <td>${esc(p.note || "")}<br/><span class="muted">${p.files.length ? p.files.map((f) => esc(f.path)).join(", ") : "no files"}</span></td>
      <td class="muted">${esc(p.proposedBy || "?")}${p.channelSlug ? ` in ${esc(p.channelSlug)}` : ""}<br/>${fmtWhen(p.createdAt)}</td>
      <td><span class="skills-inline">${p.files.length ? `<button type="button" class="ghost" data-action="view-proposal" data-id="${p.id}">files</button>` : ""}<button type="button" data-action="approve-proposal" data-id="${p.id}">Approve</button><button type="button" class="ghost" data-action="reject-proposal" data-id="${p.id}">Reject</button></span></td>
    </tr>`).join("");
  return `
    <h3>Staged source revisions</h3>
    <p class="skills-note">Skills a review-mode source delivered. Approving makes the revision active for every conversation that grants the skill; rejecting keeps the current one.</p>
    <table class="skills-table"><thead><tr><th>Skill</th><th>Revision</th><th>From</th><th>Received</th><th></th></tr></thead><tbody>${stagedRows || '<tr><td colspan="5" class="muted">Nothing staged.</td></tr>'}</tbody></table>
    ${state.fileView?.kind === "revision" ? `<div class="card skills-detail"><h3>Revision #${state.fileView.revisionNo} files</h3>${state.fileView.files.map((f) => `<p><strong>${esc(f.path)}</strong> <span class="skills-muted">${f.size} B</span></p>${f.content != null ? `<pre>${esc(f.content)}</pre>` : ""}`).join("")}</div>` : ""}
    <h3 style="margin-top:18px">Proposals</h3>
    <p class="skills-note">Changes members proposed from chat. Approving a change publishes a revision (pinned as a local override when the skill comes from a source); approving a promotion grants the skill organization-wide.</p>
    <table class="skills-table"><thead><tr><th>Proposal</th><th>Note / files</th><th>By</th><th></th></tr></thead><tbody>${proposalRows || '<tr><td colspan="4" class="muted">No pending proposals.</td></tr>'}</tbody></table>
    ${state.fileView?.kind === "proposal" ? `<div class="card skills-detail"><h3>Proposal #${state.fileView.id} files</h3>${state.fileView.files.map((f) => `<p><strong>${esc(f.path)}</strong></p><pre>${esc(f.encoding === "base64" ? "(binary)" : f.content)}</pre>`).join("")}</div>` : ""}`;
}

function renderSources() {
  const o = state.overview || {};
  const sources = o.sources || [];
  const rows = sources.map((s) => {
    const st = s.lastSyncStats || {};
    return `
    <tr>
      <td><span class="pill">${esc(s.kind)}</span> ${esc(s.label || "")}<br/><code>${esc(s.url)}</code>${s.ref ? `<br/><span class="muted">ref ${esc(s.ref)}</span>` : ""}${s.subpath ? `<span class="muted"> · ${esc(s.subpath)}</span>` : ""}</td>
      <td><span class="skills-inline"><select data-action="source-mode" data-id="${s.id}"><option value="review"${s.mode === "review" ? " selected" : ""}>review</option><option value="auto"${s.mode === "auto" ? " selected" : ""}>auto</option></select>
        <label><input type="checkbox" data-action="source-enabled" data-id="${s.id}"${s.enabled ? " checked" : ""}/> enabled</label></span>
        ${s.kind === "git" ? `<div class="skills-inline" style="margin-top:6px"><input placeholder="pin to commit sha" value="${esc(s.pinnedRef)}" data-field="pinnedRef" data-id="${s.id}" style="width:150px"/><button type="button" class="ghost" data-action="source-pin" data-id="${s.id}">pin</button></div>` : ""}</td>
      <td class="muted">${s.lastSyncAt ? `${fmtWhen(s.lastSyncAt)}${s.lastSyncRef ? ` · ${esc(s.lastSyncRef.slice(0, 7))}` : ""}<br/>${st.discovered ?? "?"} skills, ${st.created ?? 0} new, ${st.updated ?? 0} updated, ${st.staged ?? 0} staged${st.tombstoned ? `, ${st.tombstoned} removed` : ""}${st.conflicts?.length ? `, ${st.conflicts.length} conflicts` : ""}` : "never"}${s.lastSyncError ? `<br/><span class="skills-error">${esc(s.lastSyncError)}</span>` : ""}</td>
      <td><span class="skills-inline"><button type="button" class="ghost" data-action="sync-source" data-id="${s.id}">Sync now</button><button type="button" class="ghost" data-action="remove-source" data-id="${s.id}">Remove</button></span></td>
    </tr>`;
  }).join("");
  const settings = o.settings || {};
  return `
    <div class="skills-toolbar"><button type="button" data-action="sync-all">Sync all git sources</button><button type="button" class="ghost" data-action="refresh-host">Re-import host folders</button><span class="spacer"></span></div>
    <table class="skills-table"><thead><tr><th>Source</th><th>Mode</th><th>Last sync</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No sources yet.</td></tr>'}</tbody></table>
    <p class="skills-note">Host folders imported at boot (folder-owned skills, kept in sync by content): ${(o.hostFolders || []).map((d) => `<code>${esc(d)}</code>`).join(", ") || "none"}</p>
    <div class="card skills-detail">
      <h3>Add a source</h3>
      <div class="skills-form">
        <label class="field"><span>Kind</span><select id="src-kind"><option value="git">GitHub repository</option><option value="folder">Folder on the gateway host</option><option value="gateway">Another ChannelGate (peer gateway)</option></select></label>
        <label class="field"><span>URL or path</span><input id="src-url" placeholder="https://github.com/anthropics/skills, /srv/skills, or http://peer-gateway:4748" /></label>
        <label class="field"><span>Peer access token (gateway kind only; minted on the peer with the sync scope)</span><input id="src-secret" type="password" autocomplete="off" placeholder="cgs_…" /></label>
        <label class="field"><span>Label</span><input id="src-label" placeholder="Anthropic skills" /></label>
        <label class="field"><span>Branch / tag (git; empty = default, or use a /tree/ URL)</span><input id="src-ref" placeholder="main" /></label>
        <label class="field"><span>Subfolder (only discover skills below it)</span><input id="src-subpath" placeholder="skills" /></label>
        <label class="field"><span>Mode</span><select id="src-mode"><option value="review">review — stage every change for approval</option><option value="auto">auto — activate on sync</option></select></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="add-source">Add and sync</button></div>
    </div>
    <div class="card skills-detail">
      <h3>Sync settings</h3>
      <div class="skills-form">
        <label class="field"><span>GitHub token (private repositories, rate limits) — ${settings.hasGithubToken ? "set" : "not set"}</span><input id="skills-gh-token" type="password" placeholder="${settings.hasGithubToken ? "•••••••• (leave empty to keep)" : "ghp_… (optional)"}" autocomplete="off" /></label>
        <label class="field"><span>Sync interval (minutes, 0 = off)</span><input id="skills-interval" type="number" min="0" value="${Number(settings.syncIntervalMinutes ?? 60)}" /></label>
        <label class="field"><span>Context soft cap (tokens of always-on skill descriptions per conversation)</span><input id="skills-warn" type="number" min="1" value="${Number(settings.contextWarnTokens ?? 6000)}" /></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-settings">Save</button>${settings.hasGithubToken ? `<button type="button" class="ghost" data-action="clear-gh-token">Clear token</button>` : ""}</div>
    </div>
    <div class="card skills-detail">
      <h3>Publishing to Git</h3>
      <p class="skills-note">Skills authored or approved here are pushed to this repository (one commit per file, under the folder below) with the GitHub token above. When the repository is also a source, the published skill becomes that source's skill.</p>
      <div class="skills-form">
        <label class="field"><span>Repository (owner/repo or URL; empty = off)</span><input id="pub-repo" value="${esc(settings.publish?.repo ? `${settings.publish.owner}/${settings.publish.repo}` : "")}" placeholder="makeitfutureDev/makeitfuture-private-skills" /></label>
        <label class="field"><span>Branch</span><input id="pub-branch" value="${esc(settings.publish?.branch || "main")}" /></label>
        <label class="field"><span>Folder in the repository</span><input id="pub-subpath" value="${esc(settings.publish?.subpath || "skills")}" /></label>
        <label class="field"><span>Mode</span><select id="pub-mode"><option value="commit"${settings.publish?.mode !== "off" ? " selected" : ""}>commit on create / update / approve</option><option value="off"${settings.publish?.mode === "off" ? " selected" : ""}>off</option></select></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-publish">Save publishing</button>${settings.publishSourceId ? `<span class="skills-muted">Also source #${settings.publishSourceId} — published skills are adopted by it.</span>` : ""}</div>
    </div>
    <div class="card skills-detail">
      <h3>GitHub webhook</h3>
      <p class="skills-note">Add a webhook on each source repository (push events, JSON, secret below) pointing at ${settings.webhookUrl ? `<code>${esc(settings.webhookUrl)}</code>` : "<em>&lt;public URL&gt;/api/skills/webhook/github</em> (set the public URL in Settings)"} and pushes sync within seconds instead of on the interval.</p>
      <div class="skills-form">
        <label class="field"><span>Webhook secret — ${settings.hasWebhookSecret ? "set" : "not set"}</span><input id="hook-secret" type="password" autocomplete="off" placeholder="${settings.hasWebhookSecret ? "•••••••• (leave empty to keep)" : "a long random string"}" /></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-webhook">Save secret</button>${settings.hasWebhookSecret ? `<button type="button" class="ghost" data-action="clear-webhook">Clear</button>` : ""}</div>
    </div>
    <div class="card skills-detail">
      <h3>MCP endpoint &amp; access tokens</h3>
      <p class="skills-note">Any MCP client — Claude Code on a laptop, Codex, another gateway — can use this catalog at ${settings.mcpUrl ? `<code>${esc(settings.mcpUrl)}</code>` : "<em>&lt;public URL&gt;/mcp/skills</em>"} with a bearer token minted here. Scopes: <strong>read</strong> (search/read), <strong>propose</strong> (suggest changes), <strong>manage</strong> (create/update local skills), <strong>sync</strong> (export, for a peer gateway). The value is shown once.</p>
      <div class="skills-inline">
        <input id="tok-name" placeholder="token name (e.g. Tiberiu's laptop)" />
        <label><input type="checkbox" class="tok-scope" value="read" checked /> read</label>
        <label><input type="checkbox" class="tok-scope" value="propose" /> propose</label>
        <label><input type="checkbox" class="tok-scope" value="manage" /> manage</label>
        <label><input type="checkbox" class="tok-scope" value="sync" /> sync</label>
        <button type="button" data-action="create-token">Create token</button>
      </div>
      ${state.newToken ? `<p class="skills-ok">Token <strong>${esc(state.newToken.record.name)}</strong> — copy it now, it will not be shown again:</p><pre>${esc(state.newToken.token)}</pre><pre>claude mcp add --transport http channelgate-skills ${esc(settings.mcpUrl || "<public-url>/mcp/skills")} --header "Authorization: Bearer ${esc(state.newToken.token)}"</pre>` : ""}
      <table class="skills-table"><thead><tr><th>Token</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${(state.overview?.tokens || []).map((t) => `<tr><td>${esc(t.name)} <span class="muted">${esc(t.prefix)}…</span>${t.revoked ? ' <span class="pill">revoked</span>' : ""}</td><td>${esc(t.scopes.join(", "))}</td><td class="muted">${fmtWhen(t.createdAt)}</td><td class="muted">${fmtWhen(t.lastUsedAt)}</td><td>${t.revoked ? `<button type="button" class="ghost" data-action="delete-token" data-id="${t.id}">delete</button>` : `<button type="button" class="ghost" data-action="revoke-token" data-id="${t.id}">revoke</button>`}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No tokens yet.</td></tr>'}</tbody></table>
    </div>`;
}

function renderTemplates() {
  const templates = state.overview?.templates || [];
  const channels = state.profiles || [];
  const cards = templates.map((t) => `
    <div class="card">
      <h4>${esc(t.name)} <span class="muted">(${esc(t.slug)})</span>${t.builtin ? ' <span class="pill">built-in</span>' : ""}</h4>
      <p>${esc(t.description || "")}</p>
      <p class="who">categories: ${esc(t.categories.join(", ") || "—")}<br/>explicit: ${esc(t.skills.join(", ") || "—")}</p>
      <p>${t.resolved.length ? `${t.resolved.length} skill(s): ${t.resolved.map((s) => `<code>${esc(s)}</code>`).join(" ")}` : '<span class="muted">resolves to no skills yet</span>'}${t.missing.length ? `<br/><span class="skills-error">missing: ${esc(t.missing.join(", "))}</span>` : ""}</p>
      <div class="skills-actions"><button type="button" class="ghost" data-action="edit-template" data-slug="${esc(t.slug)}">Edit</button>${t.builtin ? "" : `<button type="button" class="ghost" data-action="delete-template" data-slug="${esc(t.slug)}">Delete</button>`}</div>
    </div>`).join("");
  const e = state.editTemplate;
  const form = e ? `
    <div class="card skills-detail">
      <h3>${e.isNew ? "New template" : `Edit ${esc(e.name)}`}</h3>
      <div class="skills-form">
        <label class="field"><span>Name</span><input id="tpl-name" value="${esc(e.name || "")}" /></label>
        <label class="field"><span>Slug</span><input id="tpl-slug" value="${esc(e.slug || "")}"${e.isNew ? "" : " readonly"} /></label>
        <label class="field wide"><span>Description</span><input id="tpl-desc" value="${esc(e.description || "")}" /></label>
        <label class="field"><span>Categories (comma-separated; every skill in these categories)</span><input id="tpl-cats" value="${esc((e.categories || []).join(", "))}" /></label>
        <label class="field"><span>Explicit skills (comma-separated slugs)</span><input id="tpl-skills" value="${esc((e.skills || []).join(", "))}" /></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-template">Save</button><button type="button" class="ghost" data-action="cancel-template">Cancel</button></div>
    </div>` : "";
  const preview = state.templatePreview;
  return `
    <p class="skills-note">Templates are edited under <a href="/settings#set-templates">Settings → Access Templates</a>. A conversation <strong>follows</strong> its template live and adds its own skills on top.</p>
    <div class="skills-toolbar"><button type="button" class="ghost" data-action="new-template">+ New template</button><span class="spacer"></span></div>
    ${form}
    <div class="skills-cards">${cards || '<p class="muted">No templates.</p>'}</div>
    <div class="card skills-detail">
      <h3>Assign a template to a conversation</h3>
      <div class="skills-inline">
        <select id="apply-template"><option value="none"${state.applyTemplate === "none" ? " selected" : ""}>none (stop following)</option>${templates.map((t) => `<option value="${esc(t.slug)}"${t.slug === state.applyTemplate ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
        <select id="apply-channel">${channels.map((c) => `<option value="${esc(c.slug)}"${c.slug === state.applyChannel ? " selected" : ""}>${esc(c.name || c.slug)}${c.skillTemplate ? ` — follows ${esc(c.skillTemplate)}` : ""} (${c.skills.length} skills)</option>`).join("")}</select>
        <button type="button" class="ghost" data-action="preview-template">Preview</button>
        <button type="button" data-action="apply-template">Assign</button>
      </div>
      ${preview ? `<p class="skills-note"><strong>${esc(preview.template ? preview.template.name : "no template")}</strong> → gain ${esc(preview.add.join(", ") || "nothing")}; keep ${esc(preview.keep.join(", ") || "nothing")}; drop ${esc(preview.remove.join(", ") || "nothing")}. Channel tier: ${preview.names.length} skill(s), ~${preview.profile.contextTokens} always-on tokens.${preview.profile.warnings.length ? `<br/><span class="skills-error">${esc(preview.profile.warnings.join(" · "))}</span>` : ""}</p>` : ""}
    </div>`;
}

function renderUsage() {
  const channels = state.profiles || [];
  const r = state.usage;
  const rows = (r?.used || []).map((u) => `<tr><td><code>${esc(u.slug)}</code>${u.inCatalog ? "" : ' <span class="pill">not in catalog</span>'}</td><td class="num">${u.total}</td><td class="num">${u.exact}</td><td class="num">${u.inferred}</td><td class="num">${u.users}</td><td class="num">${u.channels}</td><td class="muted">${fmtWhen(u.lastTs)}</td></tr>`).join("");
  return `
    <div class="skills-toolbar">
      <select id="usage-channel"><option value="">every conversation</option>${channels.map((c) => `<option value="${esc(c.slug)}"${c.slug === state.usageChannel ? " selected" : ""}>${esc(c.name || c.slug)}</option>`).join("")}</select>
      <select id="usage-days">${[7, 30, 90, 365].map((d) => `<option value="${d}"${d === state.usageDays ? " selected" : ""}>last ${d} days</option>`).join("")}</select>
      <button type="button" data-action="load-usage">Load</button>
      <span class="spacer"></span>
    </div>
    ${r ? `
    <table class="skills-table"><thead><tr><th>Skill</th><th>Uses</th><th>Exact</th><th>Inferred</th><th>Users</th><th>Conversations</th><th>Last</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">No skill use recorded in this range.</td></tr>'}</tbody></table>
    ${r.channelSlug ? `<p class="skills-note"><strong>Granted but never fired</strong> (${r.neverUsed.length}): ${r.neverUsed.map((n) => `<code>${esc(n.slug)}</code>`).join(" ") || "none"}${r.contextTokens != null ? ` · always-on context ~${r.contextTokens} tokens` : ""}</p>` : ""}
    <p class="skills-muted">${esc(r.notes[0])}</p>` : '<p class="skills-note">Pick a conversation (or all) and a range.</p>'}
    <h3 style="margin-top:18px">Profiles</h3>
    <table class="skills-table"><thead><tr><th>Conversation</th><th>Skills</th><th>Always-on tokens</th><th>Warnings</th></tr></thead><tbody>${channels.map((c) => `<tr><td>${esc(c.name || c.slug)} <span class="muted">${esc(c.platform || "")}${c.isDM ? " · DM" : ""}</span></td><td class="desc">${c.skills.map((s) => `<code>${esc(s)}</code>`).join(" ") || '<span class="muted">none</span>'}</td><td class="num">${c.contextTokens}</td><td class="num">${c.warnings || ""}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No conversations.</td></tr>'}</tbody></table>`;
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────

const val = (id) => document.getElementById(id)?.value ?? "";

// The apply controls survive a re-render (a preview re-renders the panel): what the user picked
// is what Apply acts on, never the first option again.
function rememberApplySelection() {
  state.applyTemplate = val("apply-template");
  state.applyChannel = val("apply-channel");
  state.applyMode = val("apply-mode") === "replace" ? "replace" : "add";
}

async function act(action, el) {
  const id = el.dataset.id;
  const slug = el.dataset.slug;
  switch (action) {
    case "select":
      await withStatus(() => loadDetail(slug));
      break;
    case "close-detail":
      state.selected = "";
      state.detail = null;
      break;
    case "view-file": {
      const r = await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/file?path=${encodeURIComponent(el.dataset.path)}`));
      if (r) state.fileView = { path: r.file.path, content: r.file.encoding === "base64" ? `(binary, ${r.file.size} bytes)` : r.file.content };
      break;
    }
    case "pin":
      await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/pin`, { method: "POST", body: JSON.stringify({ revisionNo: Number(el.dataset.rev) }) }), `Pinned revision #${el.dataset.rev}.`);
      await refreshAll();
      break;
    case "unpin":
      await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/pin`, { method: "POST", body: JSON.stringify({ revisionNo: null }) }), "Following the current revision again.");
      await refreshAll();
      break;
    case "grant": {
      const channel = val("grant-channel");
      const target = (state.profiles || []).find((c) => c.slug === channel);
      const r = await withStatus(() => api(`/api/skills/profile/${encodeURIComponent(channel)}/grant`, { method: "POST", body: JSON.stringify({ slugs: [state.selected] }) }));
      if (r) setMessage(r.added.length ? `Granted ${r.added.join(", ")} in ${target?.name || channel} (active on its next message).` : `${state.selected} was already granted in ${target?.name || channel}.`);
      await refreshAll();
      break;
    }
    case "remove":
      if (await confirmDialog({ title: `Remove ${state.selected} from the catalog?`, body: "It stays out of the catalog across syncs and imports until you restore it; its revisions are kept. Conversations that grant it report it as removed.", confirmLabel: "Remove", danger: true })) {
        await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}`, { method: "DELETE" }), `Removed ${state.selected}.`);
        await refreshAll();
      }
      break;
    case "restore":
      await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/restore`, { method: "POST", body: "{}" }), `Restored ${state.selected}.`);
      await refreshAll();
      break;
    case "new-skill":
      state.newSkill = true;
      break;
    case "cancel-new-skill":
      state.newSkill = false;
      break;
    case "save-new-skill": {
      const files = [{ path: "SKILL.md", content: val("ns-skill") }];
      if (val("ns-extra-path").trim()) files.push({ path: val("ns-extra-path").trim(), content: val("ns-extra") });
      const r = await withStatus(() => api("/api/skills/catalog", { method: "POST", body: JSON.stringify({ slug: val("ns-slug").trim(), files, note: val("ns-note") }) }), "Skill created.");
      if (r) {
        state.newSkill = false;
        state.selected = r.skill.slug;
        await refreshAll();
      }
      break;
    }
    case "view-rev": {
      const r = await withStatus(() => api(`/api/skills/revisions/${id}/files?content=1`));
      if (r) state.fileView = { kind: "revision", revisionNo: r.revision.revisionNo, files: r.files };
      break;
    }
    case "approve-rev":
      await withStatus(() => api(`/api/skills/revisions/${id}/approve`, { method: "POST", body: "{}" }), "Revision approved and active.");
      state.fileView = null;
      await refreshAll();
      break;
    case "reject-rev":
      await withStatus(() => api(`/api/skills/revisions/${id}/reject`, { method: "POST", body: JSON.stringify({ note: "rejected in the admin UI" }) }), "Revision rejected.");
      state.fileView = null;
      await refreshAll();
      break;
    case "view-proposal": {
      const p = (state.overview?.proposals || []).find((x) => String(x.id) === String(id));
      if (p) state.fileView = { kind: "proposal", id: p.id, files: p.files };
      break;
    }
    case "approve-proposal":
      await withStatus(() => api(`/api/skills/proposals/${id}/approve`, { method: "POST", body: "{}" }), `Proposal #${id} approved.`);
      state.fileView = null;
      await refreshAll();
      break;
    case "reject-proposal":
      await withStatus(() => api(`/api/skills/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ note: "rejected in the admin UI" }) }), `Proposal #${id} rejected.`);
      state.fileView = null;
      await refreshAll();
      break;
    case "sync-source": {
      const r = await withStatus(() => api(`/api/skills/sources/${id}/sync`, { method: "POST", body: "{}" }));
      if (r) setMessage(r.result?.ok === false ? `Sync failed: ${r.result.error}` : `Synced: ${r.result?.discovered ?? r.result?.presentSlugs?.length ?? 0} skill(s) found, ${r.result?.staged ?? 0} staged, ${r.result?.created ?? r.result?.imported?.length ?? 0} new.`, r.result?.ok === false);
      await refreshAll();
      break;
    }
    case "sync-all": {
      const r = await withStatus(() => api("/api/skills/sources/sync-all", { method: "POST", body: "{}" }));
      if (r) setMessage(`${r.results.length} source(s) synced; ${r.results.filter((x) => !x.ok).length} failed.`);
      await refreshAll();
      break;
    }
    case "refresh-host": {
      const r = await withStatus(() => api("/api/skills/sources/refresh-host", { method: "POST", body: "{}" }));
      if (r) setMessage(`Host folders re-imported: ${r.result.results.reduce((n, x) => n + x.presentSlugs.length, 0)} skill(s), ${r.result.tombstoned} removed, ${r.result.restored} restored.`);
      await refreshAll();
      break;
    }
    case "remove-source":
      if (await confirmDialog({ title: "Remove this source?", body: "Its skills are tombstoned (kept, restorable) and no longer granted.", confirmLabel: "Remove", danger: true })) {
        await withStatus(() => api(`/api/skills/sources/${id}`, { method: "DELETE" }), "Source removed.");
        await refreshAll();
      }
      break;
    case "source-pin": {
      const input = body().querySelector(`input[data-field="pinnedRef"][data-id="${id}"]`);
      await withStatus(() => api(`/api/skills/sources/${id}`, { method: "PUT", body: JSON.stringify({ pinnedRef: input?.value?.trim() || "" }) }), input?.value?.trim() ? "Source pinned." : "Source unpinned.");
      await refreshAll();
      break;
    }
    case "add-source": {
      const r = await withStatus(() => api("/api/skills/sources", { method: "POST", body: JSON.stringify({ kind: val("src-kind"), url: val("src-url").trim(), label: val("src-label").trim(), ref: val("src-ref").trim(), subpath: val("src-subpath").trim(), mode: val("src-mode"), ...(val("src-secret").trim() ? { secret: val("src-secret").trim() } : {}) }) }));
      if (r) setMessage(r.sync?.ok === false ? `Source added, but the first sync failed: ${r.sync.error}` : `Source added and synced (${r.sync?.discovered ?? r.sync?.presentSlugs?.length ?? 0} skill(s), ${r.sync?.staged ?? 0} staged).`, r.sync?.ok === false);
      await refreshAll();
      break;
    }
    case "save-settings": {
      const patch = { skillsSyncIntervalMinutes: Number(val("skills-interval")), skillsContextWarnTokens: Number(val("skills-warn")) };
      if (val("skills-gh-token").trim()) patch.skillsGithubToken = val("skills-gh-token").trim();
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify(patch) }), "Settings saved (the sync interval applies after the next restart).");
      await refreshAll();
      break;
    }
    case "clear-gh-token":
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ clearSkillsGithubToken: true }) }), "GitHub token cleared.");
      await refreshAll();
      break;
    case "save-publish":
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ skillsPublishRepo: val("pub-repo").trim(), skillsPublishBranch: val("pub-branch").trim(), skillsPublishSubpath: val("pub-subpath").trim(), skillsPublishMode: val("pub-mode") }) }), val("pub-repo").trim() ? "Publishing configured." : "Publishing turned off.");
      await refreshAll();
      break;
    case "save-webhook":
      if (!val("hook-secret").trim()) { setMessage("Enter a secret first.", true); break; }
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ skillsWebhookSecret: val("hook-secret").trim() }) }), "Webhook secret saved.");
      await refreshAll();
      break;
    case "clear-webhook":
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ clearSkillsWebhookSecret: true }) }), "Webhook secret cleared.");
      await refreshAll();
      break;
    case "create-token": {
      const scopes = [...body().querySelectorAll(".tok-scope:checked")].map((c) => c.value);
      const r = await withStatus(() => api("/api/skills/tokens", { method: "POST", body: JSON.stringify({ name: val("tok-name").trim(), scopes }) }), "Token created — copy it now.");
      if (r) state.newToken = r;
      await refreshAll();
      break;
    }
    case "revoke-token":
      await withStatus(() => api(`/api/skills/tokens/${id}/revoke`, { method: "POST", body: "{}" }), "Token revoked.");
      state.newToken = null;
      await refreshAll();
      break;
    case "delete-token":
      await withStatus(() => api(`/api/skills/tokens/${id}`, { method: "DELETE" }), "Token deleted.");
      await refreshAll();
      break;
    case "toggle-visibility": {
      const next = state.detail?.skill?.visibility === "personal" ? "org" : "personal";
      await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/visibility`, { method: "POST", body: JSON.stringify({ visibility: next }) }), next === "personal" ? "Now a personal skill (author only)." : "Now an organization skill.");
      await refreshAll();
      break;
    }
    case "org-grant":
      await withStatus(() => api("/api/skills/org/grant", { method: "POST", body: JSON.stringify({ slugs: [state.selected] }) }), `${state.selected} is granted organization-wide.`);
      await refreshAll();
      break;
    case "org-revoke":
      await withStatus(() => api("/api/skills/org/revoke", { method: "POST", body: JSON.stringify({ slugs: [state.selected] }) }), `${state.selected} is no longer granted organization-wide.`);
      await refreshAll();
      break;
    case "publish-now": {
      const r = await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/publish`, { method: "POST", body: "{}" }));
      if (r) setMessage(r.result.published ? `Published to ${r.result.repo}@${r.result.branch} (${r.result.files.length} file(s))${r.result.adopted ? "; now owned by that source" : ""}.` : `Not published: ${r.result.reason}`, !r.result.published);
      await refreshAll();
      break;
    }
    case "new-template":
      state.editTemplate = { isNew: true, name: "", slug: "", description: "", categories: [], skills: [] };
      break;
    case "edit-template":
      state.editTemplate = { ...(state.overview.templates.find((t) => t.slug === slug) || {}), isNew: false };
      break;
    case "cancel-template":
      state.editTemplate = null;
      break;
    case "save-template": {
      const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const r = await withStatus(() => api("/api/skills/templates", { method: "POST", body: JSON.stringify({ slug: val("tpl-slug").trim(), name: val("tpl-name").trim(), description: val("tpl-desc").trim(), categories: split(val("tpl-cats")), skills: split(val("tpl-skills")) }) }), "Template saved.");
      if (r) {
        state.editTemplate = null;
        await refreshAll();
      }
      break;
    }
    case "delete-template":
      if (await confirmDialog({ title: `Delete template ${slug}?`, body: "Conversations that follow it keep only their own added skills afterwards.", confirmLabel: "Delete", danger: true })) {
        await withStatus(() => api(`/api/skills/templates/${encodeURIComponent(slug)}`, { method: "DELETE" }), "Template deleted.");
        await refreshAll();
      }
      break;
    case "preview-template": {
      rememberApplySelection();
      const r = await withStatus(() => api(`/api/skills/templates/${encodeURIComponent(state.applyTemplate === "none" ? "" : state.applyTemplate)}/preview?channel=${encodeURIComponent(state.applyChannel)}`).catch((err) => { if (state.applyTemplate === "none") return { preview: null }; throw err; }));
      if (r) state.templatePreview = r.preview;
      break;
    }
    case "apply-template": {
      rememberApplySelection();
      const r = await withStatus(() => api(`/api/skills/profile/${encodeURIComponent(state.applyChannel)}/template`, { method: "POST", body: JSON.stringify({ template: state.applyTemplate }) }));
      if (r) setMessage(r.assigned.template ? `${state.applyChannel} now follows ${r.assigned.template.name}: gains ${r.assigned.add.length}, drops ${r.assigned.remove.length} — channel tier ${r.assigned.names.length} skill(s).` : `${state.applyChannel} follows no template now.`);
      state.templatePreview = null;
      await refreshAll();
      break;
    }
    case "load-usage": {
      state.usageChannel = val("usage-channel");
      state.usageDays = Number(val("usage-days")) || 30;
      const r = await withStatus(() => api(`/api/skills/usage?channel=${encodeURIComponent(state.usageChannel)}&days=${state.usageDays}`));
      if (r) state.usage = r.report;
      break;
    }
    default:
      return;
  }
  render();
}

function wire() {
  if (state.wired) return;
  state.wired = true;
  document.getElementById("skills-refresh").addEventListener("click", () => loadSkills());
  for (const b of document.querySelectorAll(".skills-tab")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      state.fileView = null;
      setMessage("");
      render();
    });
  }
  const root = body();
  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el || !root.contains(el)) return;
    if (el.tagName === "SELECT" || el.tagName === "INPUT") return; // change events handle these
    event.preventDefault();
    act(el.dataset.action, el).catch((err) => {
      setMessage(err?.message || String(err), true);
      render();
    });
  });
  root.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "skills-q" || el.id === "skills-owner" || el.id === "skills-removed") {
      state.query = val("skills-q");
      state.owner = val("skills-owner");
      state.showRemoved = document.getElementById("skills-removed")?.checked || false;
      refreshAll().then(render).catch((err) => { setMessage(err.message, true); render(); });
      return;
    }
    if (el.id === "apply-template" || el.id === "apply-channel" || el.id === "apply-mode") {
      rememberApplySelection();
      return;
    }
    if (el.dataset.action === "source-mode" || el.dataset.action === "source-enabled") {
      const patch = el.dataset.action === "source-mode" ? { mode: el.value } : { enabled: el.checked };
      withStatus(() => api(`/api/skills/sources/${el.dataset.id}`, { method: "PUT", body: JSON.stringify(patch) }), "Source updated.").then(refreshAll).then(render);
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.id === "skills-q") {
      event.preventDefault();
      state.query = val("skills-q");
      refreshAll().then(render).catch((err) => { setMessage(err.message, true); render(); });
    }
  });
}
