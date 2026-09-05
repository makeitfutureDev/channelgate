// The Skills view of the admin UI: the local skill catalog (browse, read, author, pin/rollback,
// remove), the review queue (staged source revisions + proposals), sources (GitHub / gateway,
// sync, settings), templates (edit, preview and apply to a conversation) and usage. Talks to
// src/web/routes/skills.js. No framework — one delegated click handler per panel.
import { api } from "./admin-api.js";
import { confirmDialog, escapeHtml as esc } from "./admin-view.js";

const state = {
  tab: "usage",
  overview: null,
  catalog: null,
  catalogAll: null,
  profiles: null,
  selected: "",
  detail: null,
  fileView: null,
  query: "",
  owner: "",
  category: "",
  source: "",
  showRemoved: false,
  newSkill: false,
  sourceModal: false,
  editTemplate: null,
  templateSkillQuery: "",
  usageChannel: "",
  usageDays: 30,
  usage: null,
  usageQuery: "",
  usageView: "skill",
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
  const [overview, catalog, catalogAll, profiles] = await Promise.all([
    api("/api/skills/overview"),
    api(`/api/skills/catalog?q=${encodeURIComponent(state.query)}${state.owner ? `&owner=${encodeURIComponent(state.owner)}` : ""}${state.category ? `&category=${encodeURIComponent(state.category)}` : ""}${state.source ? `&source=${encodeURIComponent(state.source)}` : ""}${state.showRemoved ? "&deleted=1" : ""}`),
    api("/api/skills/catalog"),
    api("/api/skills/profiles"),
  ]);
  state.overview = overview;
  state.catalog = catalog;
  state.catalogAll = catalogAll;
  state.profiles = profiles.profiles;
  if (!state.usage) state.usage = (await api("/api/skills/usage?days=30")).report;
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
  const panel = { catalog: renderCatalog, review: renderReview, sources: renderSources, sync: renderSyncSettings, mcp: renderMcp, templates: renderTemplates, usage: renderUsage }[state.tab] || renderCatalog;
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

// "#channel" for a channel id (the section key), falling back to the id itself.
function channelLabel(channelId) {
  const ch = (state.profiles || []).find((c) => c.channelId === channelId);
  return ch ? `#${ch.name || ch.slug}` : channelId;
}

function renderCatalog() {
  const skills = state.catalog?.skills || [];
  const cats = state.catalog?.categories || [];
  const owners = ["", "bundled", "local", "folder", "git"];
  const sources = state.catalog?.sources || [];
  const rows = skills.map((s) => `
    <tr class="clickable${s.slug === state.selected ? " selected" : ""}" data-action="select" data-slug="${esc(s.slug)}">
      <td><code>${esc(s.slug)}</code>${s.visibility === "personal" ? ' <span class="pill">personal</span>' : ""}${s.excluded ? ' <span class="pill">excluded</span>' : s.deleted ? ' <span class="pill">removed</span>' : ""}${s.channelScope ? ` <span class="pill" title="Kept in this channel's section of the skills repository">${esc(channelLabel(s.channelScope))}</span>` : ""}${s.pinnedRevisionId ? ' <span class="pill">pinned</span>' : ""}${s.stagedCount ? ` <span class="pill">${s.stagedCount} staged</span>` : ""}${s.currentRevisionId == null && !s.deleted ? ' <span class="pill">not active</span>' : ""}</td>
      <td class="desc">${esc(s.description)}</td>
      <td>${esc(s.category || "—")}</td>
      <td><span class="muted">${esc(ownerLabel(s))}</span></td>
      <td>${esc(s.version || "—")}</td>
      <td><label title="Available in the catalog"><input type="checkbox" data-action="skill-enabled" data-slug="${esc(s.slug)}"${s.enabled ? " checked" : ""}/> Enabled</label></td>
      <td><label title="Approved members and agents may find and grant it"><input type="checkbox" data-action="skill-discoverable" data-slug="${esc(s.slug)}"${s.discoverable ? " checked" : ""}${s.mandatory ? " disabled" : ""}/> Discoverable</label></td>
      <td><label title="Loaded in every conversation"><input type="checkbox" data-action="skill-mandatory" data-slug="${esc(s.slug)}"${s.mandatory ? " checked" : ""}/> Mandatory</label></td>
      <td class="num">${s.usage30d?.total || 0}</td>
    </tr>`).join("");
  return `
    <div class="skills-toolbar">
      <input type="search" id="skills-q" placeholder="Search slug, name, description, tags…" value="${esc(state.query)}" />
      <select id="skills-owner">${owners.map((o) => `<option value="${o}"${o === state.owner ? " selected" : ""}>${o ? esc(o) : "every owner"}</option>`).join("")}</select>
      <select id="skills-category"><option value="">every category</option>${cats.map((c) => `<option value="${esc(c.category)}"${c.category === state.category ? " selected" : ""}>${esc(c.category)} (${c.count})</option>`).join("")}</select>
      <select id="skills-source"><option value="">every source</option>${sources.map((s) => `<option value="${s.id}"${String(s.id) === state.source ? " selected" : ""}>${esc(s.label || s.url)}</option>`).join("")}</select>
      <label class="skills-inline"><input type="checkbox" id="skills-removed"${state.showRemoved ? " checked" : ""}/> show removed</label>
      <span class="spacer"></span>
      <button type="button" class="ghost" data-action="new-skill">+ New skill</button>
    </div>
    ${cats.length ? `<p class="skills-note">Categories: ${cats.map((c) => `${esc(c.category)} (${c.count})`).join(", ")}</p>` : ""}
    ${state.newSkill ? renderNewSkillForm() : ""}
    <table class="skills-table">
      <thead><tr><th>Skill</th><th>Description</th><th>Category</th><th>Owner</th><th>Version</th><th>Enabled</th><th>Discoverable</th><th>Mandatory</th><th>Usage 30d</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">No skills yet. Add a GitHub source under Sources, re-import the host folders, or create one here.</td></tr>`}</tbody>
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
  const usage = d.usage ? `${d.usage.total} use(s) in 90 days, last ${fmtWhen(d.usage.lastTs)}` : "no use recorded in 90 days";
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
        <span class="skills-inline" title="Library = shared with every conversation; a channel section = that customer/project only, granted there automatically">Section
          <select id="scope-channel"><option value=""${s.channelScope ? "" : " selected"}>Shared library</option>${channels.filter((c) => c.channelId && !c.isDM).map((c) => `<option value="${esc(c.channelId)}"${c.channelId === s.channelScope ? " selected" : ""}>#${esc(c.name || c.slug)}</option>`).join("")}</select>
          <button type="button" class="ghost" data-action="set-scope">Move</button>
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
      <td><span class="pill">${esc(s.kind)}</span> ${esc(s.label || "")}<br/><code>${esc(s.url)}</code>${s.ref ? `<br/><span class="muted">ref ${esc(s.ref)}</span>` : ""}${s.subpath ? `<span class="muted"> · ${esc(s.subpath)}</span>` : ""}
        ${s.kind !== "folder" ? `<div class="skills-inline" style="margin-top:6px"><input id="source-secret-${s.id}" type="password" autocomplete="off" placeholder="${s.hasSecret ? "•••••••• (leave empty to keep)" : s.kind === "git" ? "optional GitHub token" : "peer access token"}" style="width:190px"/><button type="button" class="ghost" data-action="save-source-secret" data-id="${s.id}">Save token</button>${s.hasSecret ? `<button type="button" class="ghost" data-action="clear-source-secret" data-id="${s.id}">Clear</button>` : ""}</div>` : ""}</td>
      <td><span class="skills-inline"><select data-action="source-mode" data-id="${s.id}"><option value="review"${s.mode === "review" ? " selected" : ""}>review</option><option value="auto"${s.mode === "auto" ? " selected" : ""}>auto</option></select>
        <label><input type="checkbox" data-action="source-enabled" data-id="${s.id}"${s.enabled ? " checked" : ""}/> enabled</label></span>
        ${s.kind === "git" ? `<div class="skills-inline" style="margin-top:6px"><input placeholder="pin to commit sha" value="${esc(s.pinnedRef)}" data-field="pinnedRef" data-id="${s.id}" style="width:150px"/><button type="button" class="ghost" data-action="source-pin" data-id="${s.id}">pin</button></div>` : ""}</td>
      <td class="muted">${s.lastSyncAt ? `${fmtWhen(s.lastSyncAt)}${s.lastSyncRef ? ` · ${esc(s.lastSyncRef.slice(0, 7))}` : ""}<br/>${st.discovered ?? "?"} skills, ${st.created ?? 0} new, ${st.updated ?? 0} updated, ${st.staged ?? 0} staged${st.tombstoned ? `, ${st.tombstoned} removed` : ""}${st.conflicts?.length ? `, ${st.conflicts.length} conflicts` : ""}` : "never"}${s.lastSyncError ? `<br/><span class="skills-error">${esc(s.lastSyncError)}</span>` : ""}</td>
      <td><span class="skills-inline"><button type="button" class="ghost" data-action="sync-source" data-id="${s.id}">Sync now</button><button type="button" class="ghost" data-action="remove-source" data-id="${s.id}">Remove</button></span></td>
    </tr>`;
  }).join("");
  return `
    <div class="skills-section-head"><div><h3>Sources</h3><p class="skills-note">GitHub repositories and other ChannelGate catalogs that feed this catalog.</p></div><button type="button" data-action="open-source">+ Add source</button></div>
    <table class="skills-table"><thead><tr><th>Source</th><th>Mode</th><th>Last sync</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No sources yet.</td></tr>'}</tbody></table>
    <p class="skills-note">Host folders imported at boot (folder-owned skills, kept in sync by content): ${(o.hostFolders || []).map((d) => `<code>${esc(d)}</code>`).join(", ") || "none"}</p>
    ${state.sourceModal ? `<div class="skills-modal" data-action="close-source"><div class="card skills-modal-card" role="dialog" aria-modal="true" aria-labelledby="add-source-title" data-modal-card>
      <div class="skills-section-head"><h3 id="add-source-title">Add a source</h3><button type="button" class="ghost" data-action="close-source" aria-label="Close">✕</button></div>
      <div class="skills-form">
        <label class="field"><span>Source type</span><select id="src-kind"><option value="git">GitHub repository</option><option value="gateway">Other ChannelGate</option></select></label>
        <label class="field"><span>Label</span><input id="src-label" placeholder="Anthropic skills" /></label>
        <label class="field" data-source-kind="git"><span>GitHub repository URL</span><input id="src-git-url" placeholder="https://github.com/owner/repo or …/tree/main/skills" /></label>
        <label class="field" data-source-kind="git"><span>Token (optional, for a private repository)</span><input id="src-git-secret" type="password" autocomplete="off" placeholder="github_pat_…" /></label>
        <label class="field" data-source-kind="gateway" hidden><span>ChannelGate URL</span><input id="src-gateway-url" placeholder="https://gateway.example.com" /></label>
        <label class="field" data-source-kind="gateway" hidden><span>Access token (minted on the other gateway with sync scope)</span><input id="src-gateway-secret" type="password" autocomplete="off" placeholder="cgs_…" /></label>
        <label class="field"><span>Mode</span><select id="src-mode"><option value="review">review — stage every change for approval</option><option value="auto">auto — activate on sync</option></select></label>
      </div>
      <div class="skills-actions"><span class="spacer"></span><button type="button" class="ghost" data-action="close-source">Cancel</button><button type="button" data-action="add-source">Add and sync</button></div>
    </div></div>` : ""}`;
}

function renderSyncSettings() {
  const o = state.overview || {};
  const settings = o.settings || {};
  return `
    <div class="skills-section-head"><div><h3>Synchronization</h3><p class="skills-note">Run imports and configure how external sources stay current.</p></div><div class="skills-inline"><button type="button" data-action="sync-all">Sync all Git sources</button><button type="button" class="ghost" data-action="refresh-host">Re-import host folders</button></div></div>
    <div class="card skills-detail">
      <h3>Catalog settings</h3>
      <div class="skills-form">
        <label class="field"><span>Sync interval (minutes, 0 = off)</span><input id="skills-interval" type="number" min="0" value="${Number(settings.syncIntervalMinutes ?? 60)}" /></label>
        <label class="field"><span>Context soft cap (tokens of always-on skill descriptions per conversation)</span><input id="skills-warn" type="number" min="1" value="${Number(settings.contextWarnTokens ?? 6000)}" /></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-settings">Save</button></div>
    </div>
    <div class="card skills-detail">
      <h3>Publishing to Git</h3>
      <p class="skills-note">Skills authored or approved here are pushed to this repository (one commit per file, under the folder below). When the repository is also a source, the published skill becomes that source's skill.</p>
      <div class="skills-form">
        <label class="field"><span>Repository (owner/repo or URL; empty = off)</span><input id="pub-repo" value="${esc(settings.publish?.repo ? `${settings.publish.owner}/${settings.publish.repo}` : "")}" placeholder="makeitfutureDev/makeitfuture-private-skills" /></label>
        <label class="field"><span>GitHub token — ${settings.hasPublishGithubToken ? "set" : "not set"}</span><input id="pub-token" type="password" autocomplete="off" placeholder="${settings.hasPublishGithubToken ? "•••••••• (leave empty to keep)" : "github_pat_…"}" /></label>
        <label class="field"><span>Folder in the repository</span><input id="pub-subpath" value="${esc(settings.publish?.subpath || "skills")}" /></label>
        <label class="field"><span>Mode</span><select id="pub-mode"><option value="commit"${settings.publish?.mode !== "off" ? " selected" : ""}>commit on create / update / approve</option><option value="off"${settings.publish?.mode === "off" ? " selected" : ""}>off</option></select></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-publish">Save publishing</button>${settings.hasPublishGithubToken ? `<button type="button" class="ghost" data-action="clear-publish-token">Clear token</button>` : ""}${settings.publishSourceId ? `<span class="skills-muted">Also source #${settings.publishSourceId} — published skills are adopted by it.</span>` : ""}</div>
    </div>
    <div class="card skills-detail">
      <h3>GitHub webhook</h3>
      <p class="skills-note">Add a webhook on each source repository (push events, JSON, secret below) pointing at ${settings.webhookUrl ? `<code>${esc(settings.webhookUrl)}</code>` : "<em>&lt;public URL&gt;/api/skills/webhook/github</em> (set the public URL in Settings)"} and pushes sync within seconds instead of on the interval.</p>
      <div class="skills-form">
        <label class="field"><span>Webhook secret — ${settings.hasWebhookSecret ? "set" : "not set"}</span><input id="hook-secret" type="password" autocomplete="off" placeholder="${settings.hasWebhookSecret ? "•••••••• (leave empty to keep)" : "a long random string"}" /></label>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-webhook">Save secret</button>${settings.hasWebhookSecret ? `<button type="button" class="ghost" data-action="clear-webhook">Clear</button>` : ""}</div>
    </div>`;
}

function renderMcp() {
  const settings = state.overview?.settings || {};
  return `
    <div class="skills-section-head"><div><h3>MCP access</h3><p class="skills-note">Connect external assistants or another ChannelGate to this catalog.</p></div></div>
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
  const e = state.editTemplate;
  const skills = (state.catalogAll?.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const selected = new Set(e?.skills || []);
  const selectedChips = [...selected].sort().map((slug) => `<span class="skills-picker-chip"><code>${esc(slug)}</code><button type="button" data-action="toggle-template-skill" data-slug="${esc(slug)}" aria-label="Remove ${esc(slug)}">×</button></span>`).join("");
  const pickerQuery = state.templateSkillQuery.trim().toLowerCase();
  const skillOptions = skills.filter((s) => !pickerQuery || `${s.name} ${s.slug} ${s.description}`.toLowerCase().includes(pickerQuery)).map((s) => `<button type="button" class="skills-picker-row${selected.has(s.slug) ? " selected" : ""}" data-action="toggle-template-skill" data-slug="${esc(s.slug)}" data-search="${esc(`${s.name} ${s.slug} ${s.description}`.toLowerCase())}"><span><strong>${esc(s.name)}</strong><code>${esc(s.slug)}</code></span><span>${selected.has(s.slug) ? "Selected" : "Add"}</span></button>`).join("");
  const form = e ? `
    <div class="card skills-detail">
      <h3>${e.isNew ? "New template" : `Edit ${esc(e.name)}`}</h3>
      <div class="skills-form">
        <label class="field"><span>Name</span><input id="tpl-name" value="${esc(e.name || "")}" /></label>
        <label class="field"><span>Slug</span><input id="tpl-slug" value="${esc(e.slug || "")}"${e.isNew ? "" : " readonly"} /></label>
        <label class="field wide"><span>Description</span><input id="tpl-desc" value="${esc(e.description || "")}" /></label>
      </div>
      <div class="skills-picker">
        <label class="field"><span>Selected skills (${selected.size})</span><input id="template-skill-q" type="search" placeholder="Search skills to add…" value="${esc(state.templateSkillQuery)}" /></label>
        <div class="skills-picker-selected">${selectedChips || '<span class="muted">No explicit skills selected.</span>'}</div>
        <div class="skills-picker-results">${skillOptions || '<span class="muted">No skills in the catalog.</span>'}</div>
      </div>
      <div class="skills-actions"><button type="button" data-action="save-template">Save</button><button type="button" class="ghost" data-action="cancel-template">Cancel</button></div>
    </div>` : "";
  return `
    <div class="skills-section-head"><div><h3>Templates</h3><p class="skills-note">Select a template to inspect or edit. Conversations follow it live and keep their own additional skills.</p></div><button type="button" data-action="new-template">+ New template</button></div>
    <div class="skills-toolbar"><select id="template-select"><option value="">Select a template…</option>${templates.map((t) => `<option value="${esc(t.slug)}"${e?.slug === t.slug ? " selected" : ""}>${esc(t.name)}${t.builtin ? " · built-in" : ""} · ${t.resolved.length} skills</option>`).join("")}</select>${e && !e.isNew ? `<button type="button" class="ghost" data-action="delete-template" data-slug="${esc(e.slug)}"${e.builtin ? " disabled" : ""}>Delete</button>` : ""}</div>
    ${form}`;
}

function renderUsage() {
  const channels = state.profiles || [];
  const r = state.usage;
  const query = state.usageQuery.trim().toLowerCase();
  const byName = new Map(channels.map((c) => [c.slug, c]));
  const used = (r?.used || []).filter((u) => !query || `${u.name} ${u.slug}`.toLowerCase().includes(query)).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, state.usageChannel ? undefined : 20);
  const channelUsage = (r?.channels || []).filter((u) => { const c = byName.get(u.channelSlug); return !query || `${c?.name || ""} ${u.channelSlug}`.toLowerCase().includes(query); }).sort((a, b) => (byName.get(a.channelSlug)?.name || a.channelSlug).localeCompare(byName.get(b.channelSlug)?.name || b.channelSlug));
  const max = Math.max(1, ...(state.usageView === "skill" ? used : channelUsage).map((u) => u.total));
  const warnings = channels.filter((c) => c.warnings > 0 && (!query || `${c.name || ""} ${c.slug}`.toLowerCase().includes(query))).sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
  const skillRows = used.map((u) => `<tr><td><code>${esc(u.slug)}</code>${u.inCatalog ? "" : ' <span class="pill">not in catalog</span>'}<div class="skills-usage-bar"><i style="width:${Math.max(3, Math.round(u.total / max * 100))}%"></i></div></td><td class="num">${u.total}</td><td class="num">${u.users}</td><td class="num">${u.channels}</td><td class="muted">${fmtWhen(u.lastTs)}</td></tr>`).join("");
  const channelRows = channelUsage.map((u) => { const c = byName.get(u.channelSlug); return `<tr><td>${esc(c?.name || u.channelSlug)} <span class="muted">${esc(u.channelSlug)}</span><div class="skills-usage-bar"><i style="width:${Math.max(3, Math.round(u.total / max * 100))}%"></i></div></td><td class="num">${u.total}</td><td class="num">${u.skills}</td><td class="muted">${fmtWhen(u.lastTs)}</td></tr>`; }).join("");
  return `
    <div class="skills-toolbar">
      <div class="skills-segmented"><button type="button" data-action="usage-view" data-view="skill" class="${state.usageView === "skill" ? "active" : ""}">By skill</button><button type="button" data-action="usage-view" data-view="channel" class="${state.usageView === "channel" ? "active" : ""}">By channel</button></div>
      <input type="search" id="usage-q" placeholder="Search ${state.usageView === "skill" ? "skills" : "conversations"}…" value="${esc(state.usageQuery)}" />
      <select id="usage-channel"><option value="">every conversation</option>${channels.map((c) => `<option value="${esc(c.slug)}"${c.slug === state.usageChannel ? " selected" : ""}>${esc(c.name || c.slug)}</option>`).join("")}</select>
      <select id="usage-days">${[7, 30, 90, 365].map((d) => `<option value="${d}"${d === state.usageDays ? " selected" : ""}>last ${d} days</option>`).join("")}</select>
      <button type="button" data-action="load-usage">Load</button>
      <span class="spacer"></span>
    </div>
    ${r ? `
    ${state.usageView === "skill" ? `<table class="skills-table"><thead><tr><th>Skill</th><th>Usage</th><th>Users</th><th>Conversations</th><th>Last</th></tr></thead><tbody>${skillRows || '<tr><td colspan="5" class="muted">No matching skill use in this range.</td></tr>'}</tbody></table>` : `<table class="skills-table"><thead><tr><th>Conversation</th><th>Usage</th><th>Skills used</th><th>Last</th></tr></thead><tbody>${channelRows || '<tr><td colspan="4" class="muted">No matching conversation use in this range.</td></tr>'}</tbody></table>`}
    ${r.channelSlug ? `<p class="skills-note"><strong>Granted but never fired</strong> (${r.neverUsed.length}): ${r.neverUsed.map((n) => `<code>${esc(n.slug)}</code>`).join(" ") || "none"}${r.contextTokens != null ? ` · always-on context ~${r.contextTokens} tokens` : ""}</p>` : ""}
    ${warnings.length ? `<details class="skills-context-warnings"><summary>${warnings.length} conversation${warnings.length === 1 ? "" : "s"} over the skills context soft cap</summary><p>The warning means the always-loaded skill descriptions consume more context than the limit configured in Sync settings. It does not mean a skill failed.</p>${warnings.map((c) => `<div><strong>${esc(c.name || c.slug)}</strong> · ~${c.contextTokens} tokens<br/><span>${esc((c.warningMessages || []).join(" · "))}</span></div>`).join("")}</details>` : ""}
    ` : '<p class="skills-note">Choose a range, then load usage.</p>'}`;
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

function rememberTemplateDraft() {
  if (!state.editTemplate) return;
  state.editTemplate.name = val("tpl-name");
  state.editTemplate.slug = val("tpl-slug");
  state.editTemplate.description = val("tpl-desc");
  state.editTemplate.categories = [];
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
    case "open-source":
      state.sourceModal = true;
      break;
    case "close-source":
      state.sourceModal = false;
      break;
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
    case "save-source-secret": {
      const secret = val(`source-secret-${id}`).trim();
      if (!secret) { setMessage("Enter a token first.", true); break; }
      await withStatus(() => api(`/api/skills/sources/${id}`, { method: "PUT", body: JSON.stringify({ secret }) }), "Source token saved.");
      await refreshAll();
      break;
    }
    case "clear-source-secret":
      await withStatus(() => api(`/api/skills/sources/${id}`, { method: "PUT", body: JSON.stringify({ clearSecret: true }) }), "Source token cleared.");
      await refreshAll();
      break;
    case "add-source": {
      const kind = val("src-kind");
      const url = val(kind === "git" ? "src-git-url" : "src-gateway-url").trim();
      const secret = val(kind === "git" ? "src-git-secret" : "src-gateway-secret").trim();
      const r = await withStatus(() => api("/api/skills/sources", { method: "POST", body: JSON.stringify({ kind, url, label: val("src-label").trim(), mode: val("src-mode"), ...(secret ? { secret } : {}) }) }));
      if (r) setMessage(r.sync?.ok === false ? `Source added, but the first sync failed: ${r.sync.error}` : `Source added and synced (${r.sync?.discovered ?? r.sync?.presentSlugs?.length ?? 0} skill(s), ${r.sync?.staged ?? 0} staged).`, r.sync?.ok === false);
      if (r) state.sourceModal = false;
      await refreshAll();
      break;
    }
    case "save-settings": {
      const patch = { skillsSyncIntervalMinutes: Number(val("skills-interval")), skillsContextWarnTokens: Number(val("skills-warn")) };
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify(patch) }), "Settings saved (the sync interval applies after the next restart).");
      await refreshAll();
      break;
    }
    case "save-publish": {
      const patch = { skillsPublishRepo: val("pub-repo").trim(), skillsPublishBranch: "main", skillsPublishSubpath: val("pub-subpath").trim(), skillsPublishMode: val("pub-mode") };
      if (val("pub-token").trim()) patch.skillsPublishGithubToken = val("pub-token").trim();
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify(patch) }), val("pub-repo").trim() ? "Publishing configured." : "Publishing turned off.");
      await refreshAll();
      break;
    }
    case "clear-publish-token":
      await withStatus(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ clearSkillsPublishGithubToken: true }) }), "Publishing token cleared.");
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
    case "set-scope": {
      const channelId = document.getElementById("scope-channel")?.value || "";
      const label = channelId ? `the ${channelLabel(channelId)} section` : "the shared library";
      if (await confirmDialog({ title: `Move ${state.selected} to ${label}?`, body: channelId ? "Only that channel gets it automatically; other conversations keep any explicit grant. The files move in the skills repository." : "Every conversation can use it; the channel it leaves keeps it as an explicit grant. The files move in the skills repository.", confirmLabel: "Move" })) {
        await withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(state.selected)}/scope`, { method: "POST", body: JSON.stringify({ channelId }) }), `Moved ${state.selected} to ${label}.`);
        await refreshAll();
      }
      break;
    }
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
      state.templateSkillQuery = "";
      break;
    case "edit-template":
      state.editTemplate = { ...(state.overview.templates.find((t) => t.slug === slug) || {}), isNew: false };
      state.templateSkillQuery = "";
      break;
    case "toggle-template-skill": {
      rememberTemplateDraft();
      const selected = new Set(state.editTemplate?.skills || []);
      if (selected.has(slug)) selected.delete(slug); else selected.add(slug);
      state.editTemplate.skills = [...selected];
      break;
    }
    case "cancel-template":
      state.editTemplate = null;
      break;
    case "save-template": {
      rememberTemplateDraft();
      const draft = state.editTemplate;
      const r = await withStatus(() => api("/api/skills/templates", { method: "POST", body: JSON.stringify({ slug: draft.slug.trim(), name: draft.name.trim(), description: draft.description.trim(), categories: draft.categories, skills: draft.skills }) }), "Template saved.");
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
    case "usage-view":
      state.usageView = el.dataset.view === "channel" ? "channel" : "skill";
      break;
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
    if (el.classList.contains("skills-modal") && event.target !== el) return;
    if (el.tagName === "SELECT" || el.tagName === "INPUT") return; // change events handle these
    event.preventDefault();
    act(el.dataset.action, el).catch((err) => {
      setMessage(err?.message || String(err), true);
      render();
    });
  });
  root.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "src-kind") {
      for (const field of root.querySelectorAll("[data-source-kind]")) field.hidden = field.dataset.sourceKind !== el.value;
      return;
    }
    if (el.id === "skills-q" || el.id === "skills-owner" || el.id === "skills-category" || el.id === "skills-source" || el.id === "skills-removed") {
      state.query = val("skills-q");
      state.owner = val("skills-owner");
      state.category = val("skills-category");
      state.source = val("skills-source");
      state.showRemoved = document.getElementById("skills-removed")?.checked || false;
      refreshAll().then(render).catch((err) => { setMessage(err.message, true); render(); });
      return;
    }
    if (["skill-enabled", "skill-discoverable", "skill-mandatory"].includes(el.dataset.action)) {
      const key = el.dataset.action.replace("skill-", "");
      withStatus(() => api(`/api/skills/catalog/${encodeURIComponent(el.dataset.slug)}/governance`, { method: "POST", body: JSON.stringify({ [key]: el.checked }) }), "Skill governance updated.").then(refreshAll).then(render);
      return;
    }
    if (el.id === "apply-template" || el.id === "apply-channel" || el.id === "apply-mode") {
      rememberApplySelection();
      return;
    }
    if (el.id === "template-select") {
      const template = state.overview?.templates?.find((t) => t.slug === el.value);
      state.editTemplate = template ? { ...template, isNew: false } : null;
      state.templateSkillQuery = "";
      render();
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
  root.addEventListener("input", (event) => {
    if (event.target.id === "usage-q") {
      state.usageQuery = event.target.value;
      render();
      document.getElementById("usage-q")?.focus();
      return;
    }
    if (event.target.id === "template-skill-q") {
      state.templateSkillQuery = event.target.value;
      const q = event.target.value.trim().toLowerCase();
      for (const row of root.querySelectorAll(".skills-picker-row")) row.hidden = Boolean(q) && !row.dataset.search.includes(q);
    }
  });
}
