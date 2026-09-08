// Shared conversation/template editor. Explicit selections remain separate from inherited
// grants: changing a template must never silently rewrite the conversation's own saved list.
import { escapeHtml as esc } from "./admin-view.js";

const key = (slug) => String(slug).toLowerCase();
const unique = (slugs) => [...new Map(slugs.map((slug) => [key(slug), slug])).values()];
const sourceKey = (skill) => skill.sourceId != null ? `source:${skill.sourceId}` : `owner:${skill.ownerKind || "local"}`;

export function assignmentGroups({ skills = [], selected = [], inherited = [] }) {
  const catalog = new Map(skills.map((skill) => [key(skill.slug), skill]));
  const seen = new Set();
  const rows = (slugs) => unique(slugs).filter((slug) => {
    if (seen.has(key(slug))) return false;
    seen.add(key(slug));
    return true;
  }).map((slug) => catalog.get(key(slug)) || { slug, name: slug, unavailable: true });
  const groups = inherited.map((group) => ({ ...group, locked: true, skills: rows(group.slugs || []) }));
  const own = rows(selected);
  const available = skills.filter((skill) => !seen.has(key(skill.slug)) && !skill.deleted && skill.enabled !== false && !skill.unavailable && skill.visibility !== "personal" && (skill.currentRevisionId != null || skill.pinnedRevisionId != null));
  const sort = (items) => items.sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
  return { groups: groups.map((g) => ({ ...g, skills: sort(g.skills) })), own: sort(own), available: sort(available) };
}

export function mountSkillAssignmentPicker(root, options) {
  let config = { skills: [], sources: [], selected: [], inherited: [], selectedLabel: "Additional skills", ...options };
  let selected = unique(config.selected);
  const expanded = new Set();
  root.classList.add("skill-assignment");
  root.innerHTML = `<div class="skill-assignment-filters">
    <label class="field"><span>Search skills</span><input type="search" data-picker-query placeholder="Search by name or description…" autocomplete="off" /></label>
    <label class="field"><span>Source</span><select data-picker-source aria-label="Skill source"></select></label>
  </div><div class="skill-assignment-columns"><section class="skill-assignment-panel"><h3>Active skills <span data-active-count></span></h3><p class="skills-note" data-active-note></p><div data-picker-active></div></section>
    <section class="skill-assignment-panel"><h3>Add skills <span data-available-count></span></h3><p class="skills-note">Search the catalog and add skills to your selection.</p><div data-picker-available></div></section></div><p class="skill-assignment-status" role="status" aria-live="polite"></p>`;
  const query = root.querySelector("[data-picker-query]");
  const source = root.querySelector("[data-picker-source]");
  const sourceLabel = (skill) => config.sources.find((s) => String(s.id) === String(skill.sourceId))?.label
    || config.sources.find((s) => String(s.id) === String(skill.sourceId))?.url
    || ({ local: "Local skills", bundled: "Built-in skills", folder: "Host folders" }[skill.ownerKind])
    || (skill.sourceId != null ? `Source #${skill.sourceId}` : "Local skills");
  function paintSources() {
    const previous = source.value;
    const sources = new Map(config.skills.map((skill) => [sourceKey(skill), sourceLabel(skill)]));
    source.innerHTML = '<option value="">All sources</option>' + [...sources].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
    if (sources.has(previous)) source.value = previous;
  }
  function paint(resetScroll = false) {
    const scrollAreas = [...root.querySelectorAll("[data-picker-active], [data-picker-available]")];
    const scrollPositions = scrollAreas.map((el) => resetScroll ? 0 : el.scrollTop);
    const model = assignmentGroups({ ...config, selected });
    const q = query.value.trim().toLowerCase();
    const matches = (s) => (!q || `${s.name || ""} ${s.slug} ${s.description || ""}`.toLowerCase().includes(q)) && (!source.value || sourceKey(s) === source.value);
    const row = (s, action) => {
      const status = s.unavailable ? "Not in the current catalog · saved selection kept"
        : s.deleted || s.enabled === false ? "Disabled · saved selection kept"
        : s.currentRevisionId == null && s.pinnedRevisionId == null ? "Awaiting approval" : sourceLabel(s);
      return `<div class="skill-assignment-row" data-skill="${esc(s.slug)}">
        <details data-picker-details="${esc(s.slug)}"${expanded.has(key(s.slug)) ? " open" : ""}>
          <summary title="${esc(s.name || s.slug)} · ${esc(s.slug)} · ${esc(status)}"><span class="skill-assignment-identity"><strong>${esc(s.name || s.slug)}</strong>${s.name && s.name !== s.slug ? `<code>${esc(s.slug)}</code>` : ""}<span class="skill-assignment-source">${esc(status)}</span></span></summary>
          <div class="skill-assignment-description"><p>${esc(s.description || "No description available.")}</p><dl><dt>Name</dt><dd>${esc(s.name || s.slug)}</dd><dt>Slug</dt><dd>${esc(s.slug)}</dd><dt>Source</dt><dd>${esc(status)}</dd>${s.version ? `<dt>Version</dt><dd>${esc(s.version)}</dd>` : ""}</dl></div>
        </details>
        ${action ? `<button type="button" class="ghost" data-picker-action="${action}" data-slug="${esc(s.slug)}" aria-label="${action === "add" ? "Add" : "Remove"} ${esc(s.slug)}">${action === "add" ? "+ Add" : "Remove"}</button>` : '<span class="skill-assignment-locked" title="Managed by its inherited grant">Included</span>'}
      </div>`;
    };
    const group = (g, action) => {
      const visible = g.skills.filter(matches);
      return `<section class="skill-assignment-group" data-group="${esc(g.id || "selected")}"><h4>${esc(g.label)} <span>${visible.length === g.skills.length ? g.skills.length : `${visible.length} / ${g.skills.length}`}</span>${g.locked ? ' <span class="skill-assignment-locked">Locked</span>' : ""}</h4>${g.note ? `<p class="skills-note">${esc(g.note)}</p>` : ""}<div class="skill-assignment-list">${visible.map((s) => row(s, action)).join("") || `<p class="skill-assignment-empty">${g.skills.length ? "No matching active skills." : "No skills in this group."}</p>`}</div></section>`;
    };
    root.querySelector("[data-active-count]").textContent = model.own.length + model.groups.reduce((n, g) => n + g.skills.length, 0);
    root.querySelector("[data-active-note]").textContent = config.activeNote || "Inherited skills are included automatically. Only additional skills can be removed here.";
    root.querySelector("[data-picker-active]").innerHTML = model.groups.map((g) => group(g, null)).join("") + group({ label: config.selectedLabel, skills: model.own }, "remove");
    const available = model.available.filter(matches);
    root.querySelector("[data-available-count]").textContent = `${available.length} / ${model.available.length}`;
    root.querySelector("[data-picker-available]").innerHTML = `<div class="skill-assignment-list skill-assignment-catalog">${available.map((s) => row(s, "add")).join("") || `<p class="skill-assignment-empty">${model.available.length ? "No skills match these filters." : "All available skills are already included."}</p>`}</div>`;
    scrollAreas.forEach((el, i) => { el.scrollTop = scrollPositions[i]; });
  }
  root.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!root.contains(details) || !details.matches("[data-picker-details]")) return;
    if (details.open) expanded.add(key(details.dataset.pickerDetails));
    else expanded.delete(key(details.dataset.pickerDetails));
  }, true);
  root.addEventListener("input", (event) => { if (event.target === query) paint(true); });
  root.addEventListener("change", (event) => { if (event.target === source) paint(true); });
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-picker-action]");
    if (!button || !root.contains(button)) return;
    const slug = button.dataset.slug;
    const model = assignmentGroups({ ...config, selected });
    const isAdd = button.dataset.pickerAction === "add";
    if (!(isAdd ? model.available : model.own).some((s) => key(s.slug) === key(slug))) return;
    selected = isAdd ? unique([...selected, slug]) : selected.filter((s) => key(s) !== key(slug));
    config.onChange?.([...selected]);
    paint();
    root.querySelector(".skill-assignment-status").textContent = `${isAdd ? "Added" : "Removed"} ${slug}. Save to apply changes.`;
    // The clicked button moves between lists. Keep keyboard focus on that skill's new action.
    [...root.querySelectorAll("[data-picker-action]")].find((b) => b.dataset.slug === slug)?.focus({ preventScroll: true });
  });
  paintSources();
  paint();
  return {
    getSelected: () => [...selected],
    update(patch) {
      config = { ...config, ...patch };
      if (patch.selected) selected = unique(patch.selected);
      if (patch.skills || patch.sources) paintSources();
      paint();
    },
  };
}
