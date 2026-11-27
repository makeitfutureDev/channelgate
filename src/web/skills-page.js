// Serialized into the Activity page's Skills view; all server text is rendered as text. Pick a
// conversation (or "Only me"), filter the catalog, tick the skills its runs should load, save.
export function skillsBrowser(config, browser) {
  "use strict";
  const { document } = browser;
  const select = document.getElementById("skills-channel");
  const listEl = document.getElementById("skills-list");
  const notice = document.getElementById("skills-status");
  const info = document.getElementById("skills-info");
  const refresh = document.getElementById("skills-refresh");
  const search = document.getElementById("skills-search");
  const filters = document.getElementById("skills-filters");
  const counter = document.getElementById("skills-count");
  const bar = document.getElementById("skills-savebar");
  const barText = document.getElementById("skills-savebar-text");
  const save = document.getElementById("skills-save");
  const discard = document.getElementById("skills-discard");
  const tools = document.getElementById("skills-tools");
  const pendingEl = document.getElementById("skills-pending");
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const SOURCE = { channel: "Added here", organization: "Organization", template: "Template", repository: "Repository", personal: "Only me" };
  let data = null, current = "", filter = "all", picked = new Set(), original = new Set(), rows = [];
  let channels = [];

  async function request(path, init) {
    const response = await browser.fetch(config.base + path, { credentials: "same-origin", cache: "no-store", ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 400 || response.status === 404 || response.status === 409) throw new Error(body.error || "That change couldn’t be saved.");
      throw new Error([401, 403].includes(response.status) ? "Your session or access to this conversation has ended." : "Couldn’t load skills. Please try again.");
    }
    return body;
  }
  const dirty = () => picked.size !== original.size || [...picked].some((key) => !original.has(key));
  function paintBar() {
    const on = dirty();
    bar.hidden = !on;
    if (!on) return;
    const added = [...picked].filter((key) => !original.has(key)).length, removed = [...original].filter((key) => !picked.has(key)).length;
    barText.textContent = [added ? added + " to add" : "", removed ? removed + " to remove" : ""].filter(Boolean).join(" · ");
  }
  function paintCount() {
    const total = rows.length, on = rows.filter((row) => row.locked || picked.has(row.key.toLowerCase())).length;
    counter.textContent = on + " on · " + total + " available";
  }
  function paintList() {
    const query = String(search.value || "").trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of rows) {
      const on = row.locked || picked.has(row.key.toLowerCase());
      const text = (row.name + " " + row.key + " " + row.description).toLowerCase();
      const visible = terms.every((term) => text.includes(term)) && (filter === "all" || (filter === "on" ? on : !on));
      row.el.hidden = !visible;
      if (visible) shown++;
    }
    let empty = listEl.querySelector(".skills-empty");
    if (!shown) {
      if (!empty) { empty = node("p", "", "skills-empty"); listEl.append(empty); }
      empty.textContent = rows.length ? "No skills match your search." : "No skills are available here yet.";
    } else if (empty) empty.remove();
    paintCount();
  }
  function skillRow(skill) {
    const key = skill.key.toLowerCase();
    const label = node("label", undefined, "skills-row" + (skill.locked ? " locked" : ""));
    const box = node("input"); box.type = "checkbox"; box.checked = skill.locked || picked.has(key); box.disabled = Boolean(skill.locked) || !data.editable;
    box.addEventListener("change", () => { if (box.checked) picked.add(key); else picked.delete(key); label.classList.toggle("on", box.checked); paintBar(); paintCount(); });
    const text = node("span", undefined, "skills-row-text");
    const head = node("span", undefined, "skills-row-head");
    head.append(node("strong", skill.name));
    if (skill.name.toLowerCase() !== key) head.append(node("code", skill.key));
    const badge = skill.locked ? SOURCE[skill.source] : picked.has(key) && SOURCE[skill.source];
    if (badge) head.append(node("span", badge, "skills-badge source-" + skill.source));
    text.append(head);
    if (skill.description) text.append(node("span", skill.description, "skills-row-desc"));
    if (skill.locked) text.append(node("span", skill.source === "organization" ? "Always on for the whole organization." : "Comes from this conversation’s " + (skill.source === "template" ? "skill template" : "repository") + ".", "skills-row-note"));
    label.append(box, text);
    if (box.checked) label.classList.add("on");
    return { ...skill, el: label };
  }
  function paintInfo() {
    info.replaceChildren();
    const lines = [];
    if (data.kind === "personal") lines.push("Skills you pick here load into every run you start, in any conversation. Nobody else’s runs use them.");
    else if (data.linked) lines.push("This conversation shares the setup of " + data.linked.name + ". Change its skills there.");
    else {
      lines.push("Skills picked here load for everyone’s runs in this conversation.");
      if (data.template) lines.push("Follows the “" + data.template + "” skill template; its skills are listed as Template.");
      if (data.dmTemplate) lines.push("Your direct messages follow the organization’s default setup. Saving a change here gives them their own copy of it.");
    }
    if (data.notLoaded && data.notLoaded.length) lines.push("Not loaded: " + data.notLoaded.join(", ") + " — another person’s personal skill. Saving here removes it.");
    for (const line of lines) info.append(node("p", line));
  }
  function when(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function paintPending() {
    const list = (data && data.pending) || [];
    pendingEl.hidden = !list.length;
    pendingEl.replaceChildren();
    if (!list.length) return;
    pendingEl.append(node("h2", "Waiting for approval · " + list.length));
    pendingEl.append(node("p", (data.kind === "personal" ? "Your skill requests" : "Skill requests made in this conversation or for its own skills") + " that still need an approval or a rejection. Nothing changes until someone decides.", "skills-pending-copy"));
    const items = node("ul");
    for (const item of list) {
      const li = node("li");
      const head = node("span", undefined, "skills-row-head");
      head.append(node("strong", item.skill), node("span", item.action + (item.target ? " “" + item.target + "”" : ""), "skills-badge"));
      li.append(head);
      li.append(node("span", ["Request #" + item.id, item.by ? "by " + item.by : "", when(item.createdAt)].filter(Boolean).join(" · "), "skills-row-note"));
      li.append(node("span", item.decider === "here" ? "Members of this conversation decide it: ask the agent here to approve or reject request #" + item.id + "."
        : item.decider === "channel" ? "Decided by members of " + (item.deciderChannel || "the conversation that owns the skill") + " (or an admin)."
        : "Decided by an organization admin.", "skills-row-note"));
      if (item.note) li.append(node("span", item.note, "skills-row-desc"));
      items.append(li);
    }
    pendingEl.append(items);
  }
  function render() {
    paintInfo();
    paintPending();
    tools.hidden = !data.editable;
    original = new Set(data.skills.filter((skill) => skill.selected && !skill.locked).map((skill) => skill.key.toLowerCase()));
    picked = new Set(original);
    rows = data.editable ? data.skills.map(skillRow) : [];
    listEl.replaceChildren(...rows.map((row) => row.el));
    paintList(); paintBar();
  }
  async function loadChannel() {
    if (!select.value) return;
    current = select.value;
    notice.textContent = "Loading skills…"; listEl.replaceChildren(); info.replaceChildren(); bar.hidden = true; pendingEl.hidden = true;
    try {
      data = await request("/api/skills/" + encodeURIComponent(current));
      notice.textContent = "";
      render();
    } catch (error) { data = null; rows = []; notice.textContent = error.message; tools.hidden = true; }
  }
  function optionLabel(c) { return c.name + (c.linked ? " · shared setup" : " · " + c.count + " skill" + (c.count === 1 ? "" : "s")) + (c.pending ? " · " + c.pending + " waiting for approval" : ""); }
  async function loadChannels() {
    refresh.disabled = true; notice.textContent = "Loading conversations…";
    const previous = select.value || String(browser.location?.hash || "").replace(/^#/, "");
    try {
      const body = await request("/api/skills");
      channels = body.channels;
      select.replaceChildren(...channels.map((c) => { const o = node("option", optionLabel(c)); o.value = c.channelId; return o; }));
      if (channels.some((c) => c.channelId === previous)) select.value = previous;
      await loadChannel();
    } catch (error) { notice.textContent = error.message; }
    finally { refresh.disabled = false; }
  }
  const leaveOk = () => !dirty() || browser.confirm("Discard your unsaved skill changes?");
  select.addEventListener("change", () => {
    if (!leaveOk()) { select.value = current; return; }
    try { browser.history?.replaceState(null, "", "#" + select.value); } catch { /* the hash is a convenience */ }
    void loadChannel();
  });
  refresh.addEventListener("click", () => { if (leaveOk()) void loadChannels(); });
  search.addEventListener("input", paintList);
  filters.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-filter]");
    if (!target) return;
    filter = target.dataset.filter;
    for (const b of filters.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === target));
    paintList();
  });
  discard.addEventListener("click", () => { if (data) render(); });
  save.addEventListener("click", async () => {
    if (!data || !dirty()) return;
    save.disabled = discard.disabled = true; barText.textContent = "Saving…";
    const selected = data.skills.filter((skill) => !skill.locked && picked.has(skill.key.toLowerCase())).map((skill) => skill.key);
    try {
      const result = await request("/api/skills/" + encodeURIComponent(current), { method: "POST", headers: { "Content-Type": "application/json", "X-CG-CSRF": config.csrf }, body: JSON.stringify({ selected }) });
      data = await request("/api/skills/" + encodeURIComponent(current));
      render();
      notice.textContent = result.notice || "Skills saved.";
      const entry = channels.find((c) => c.channelId === current);
      if (entry) { entry.count = data.skills.filter((skill) => skill.selected && skill.source !== "organization").length; const o = [...select.options].find((x) => x.value === current); if (o) o.textContent = optionLabel(entry); }
    } catch (error) { barText.textContent = error.message; }
    finally { save.disabled = discard.disabled = false; }
  });
  browser.addEventListener?.("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
  void loadChannels();
}

export const SKILLS_HTML = `<section class="calls-page skills-page" aria-label="Skills"><div class="calls-head"><h1>Skills</h1><button id="skills-refresh" class="order-button" type="button">Refresh</button></div><p class="calls-copy">Choose a conversation, then pick the skills its runs load. Only conversations you can access are listed; “Only me” follows you into every conversation.</p><label class="automation-picker">Conversation <select id="skills-channel"></select></label><div id="skills-info" class="skills-info"></div><div id="skills-pending" class="skills-pending" aria-label="Waiting for approval" hidden></div><div id="skills-tools" class="skills-tools" hidden><input id="skills-search" type="search" placeholder="Search skills by name or description…" maxlength="120" aria-label="Search skills"><div id="skills-filters" class="skills-filters" role="group" aria-label="Show"><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="on" aria-pressed="false">On</button><button type="button" data-filter="off" aria-pressed="false">Off</button></div><span id="skills-count" class="skills-count"></span></div><p id="skills-status" role="status" aria-live="polite">Loading…</p><div id="skills-list" class="skills-list"></div><div id="skills-savebar" class="skills-savebar" hidden><span id="skills-savebar-text"></span><button id="skills-discard" class="order-button" type="button">Discard</button><button id="skills-save" class="order-button primary" type="button">Save skills</button></div><noscript><p>Enable JavaScript to manage skills.</p></noscript></section>`;

export const SKILLS_CSS = `
.skills-info p{color:var(--muted);font-size:13px;margin:10px 0 0;line-height:1.5}
.skills-pending{margin:16px 0 0;padding:12px 16px;border:1px solid var(--orange);border-radius:10px;background:var(--panel)}
.skills-pending[hidden]{display:none}
.skills-pending h2{font-size:14px;margin:0}
.skills-pending-copy{color:var(--muted);font-size:13px;margin:4px 0 0;line-height:1.5}
.skills-pending ul{list-style:none;margin:10px 0 0;padding:0}
.skills-pending li{display:flex;flex-direction:column;gap:3px;padding:10px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.skills-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0 4px}
.skills-tools[hidden]{display:none}
#skills-search{flex:1 1 260px;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:inherit;font:inherit}
.skills-filters{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.skills-filters button{border:0;background:transparent;color:inherit;font:inherit;font-size:13px;padding:7px 12px;cursor:pointer}
.skills-filters button+button{border-left:1px solid var(--line)}
.skills-filters button[aria-pressed="true"]{background:var(--orange);color:#fff}
.skills-count{color:var(--muted);font-size:13px}
#skills-status{color:var(--muted);font-size:13px;margin:10px 0}
#skills-status:empty{display:none}
.skills-list{border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.skills-list:empty{display:none}
.skills-row{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid var(--line);cursor:pointer}
.skills-row:last-child{border-bottom:0}
.skills-row[hidden]{display:none}
.skills-row.locked{cursor:default;opacity:.85}
.skills-row input{width:16px;height:16px;margin-top:2px;flex:none;accent-color:var(--orange)}
.skills-row-text{display:flex;flex-direction:column;gap:3px;min-width:0;overflow-wrap:anywhere}
.skills-row-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:14px}
.skills-row-head code{font-size:12px;color:var(--muted)}
.skills-row-desc{color:var(--muted);font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.skills-row-note{color:var(--muted);font-size:12px;font-style:italic}
.skills-badge{font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.skills-badge.source-channel,.skills-badge.source-personal{border-color:var(--orange);color:var(--orange)}
.skills-empty{padding:16px;color:var(--muted);font-size:13px;margin:0}
.skills-savebar{position:sticky;bottom:12px;display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:0 6px 18px rgba(0,0,0,.18)}
.skills-savebar[hidden]{display:none}
#skills-savebar-text{flex:1;font-size:13px;color:var(--muted)}
.order-button.primary{background:var(--orange);border-color:var(--orange);color:#fff}
`;
