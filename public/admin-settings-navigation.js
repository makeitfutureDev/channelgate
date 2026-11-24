import { rankSettings } from "./admin-settings-search.js";

// Text inside editors can include a draft, a revealed credential or its masked suffix.
// Read labels, option names and help copy only. Never inspect an input's value.
function labelText(node) {
  if (!node || node.nodeType === 8) return "";
  if (node.nodeType === 3) return node.textContent;
  if (node.matches("input, textarea, select, button, .state, .saved, .setcard-state")) return "";
  return Array.from(node.childNodes, labelText).join(" ").replace(/\s+/g, " ").trim();
}

function searchIndex(sections) {
  const entries = [];
  for (const section of sections) {
    const category = section.querySelector("h3").textContent;
    for (const card of section.querySelectorAll(":scope > .setcard")) {
      const title = labelText(card.querySelector("h4")) || category;
      const path = [section.dataset.group, category].join(" / ");
      const help = Array.from(card.querySelectorAll(":scope > .desc, :scope > ul"), labelText);
      entries.push({ title, path, text: help.join(" "), keywords: card.dataset.setkey, target: card, isCard: true });
      const fieldPath = path + " / " + title;
      function unavailable(node) {
        const hidden = node.closest("[hidden]");
        return hidden && card.contains(hidden) && !hidden.matches(".feature-fields, [data-requires-setting], [data-mode-control]");
      }
      for (const field of card.querySelectorAll("label, .field:not(label), .dz-row, .gchat-guide-step, tr[data-model]")) {
        if (unavailable(field) || (field.querySelector("label") && !field.matches("label"))) continue;
        const control = field.querySelector("input:not([type=hidden]), textarea, select, button");
        const caption = field.querySelector(":scope > span, :scope > summary, :scope > strong");
        const captionText = field.dataset.model || labelText(caption) || labelText(field) || control?.getAttribute("aria-label");
        if (!captionText) continue;
        const fieldTitle = captionText.split(/ [—–] /)[0];
        const options = field.querySelector("select")?.options || [];
        const text = [captionText,
          ...Array.from(options, (opt) => opt.textContent),
          ...Array.from(field.querySelectorAll("small, .hint, .desc, li, p"), labelText),
        ].join(" ");
        entries.push({ title: fieldTitle, path: fieldPath, text, keywords: [control?.id?.replace(/^set-/, ""), control?.dataset.role, control?.getAttribute("aria-label")].filter(Boolean).join(" "), target: field });
      }
      for (const control of card.querySelectorAll("input[aria-label], textarea[aria-label], select[aria-label]")) {
        if (unavailable(control) || control.closest("label, .field, .dz-row")) continue;
        entries.push({ title: control.getAttribute("aria-label"), path: fieldPath, target: control });
      }
      for (const button of card.querySelectorAll("button")) {
        if (unavailable(button) || button.closest("label, .field, .dz-row, .reveal-wrap")) continue;
        const name = button.getAttribute("aria-label") || button.textContent.trim();
        if (name.length < 4 || /^(clear|remove|edit|settings|rename|copy|cancel|save)$/i.test(name)) continue;
        const context = button.closest(".lic-row")?.querySelector(".lic-name")?.textContent;
        entries.push({ title: name, path: context ? fieldPath + " / " + context : fieldPath, target: button });
      }
    }
  }
  return entries;
}

// Keep former Settings entries discoverable after their editors move to another page.
const destinations = [
  { title: "Organization variables", path: "Variables", keywords: "global environment secrets credentials", oldIds: ["org-secrets-card", "org-secrets-editor"], href: "/variables" },
  { title: "Organization skills and connectors", path: "Skills / Organization", keywords: "global grants mcp servers", oldIds: ["org-grants-editor", "org-grant-tier"], href: "/skills#organization" },
  { title: "Skill templates", path: "Skills / Templates", keywords: "skill sets assignments", oldIds: ["skill-templates-card", "skill-templates-editor"], href: "/skills#templates" },
  { title: "New channel template", path: "Conversations / Templates", keywords: "channel defaults access templates", oldIds: ["set-templates", "tpl-channel-editor"], href: "/conversations/template/channel" },
  { title: "User DM template", path: "Conversations / Templates", keywords: "user direct message defaults access templates", oldIds: ["tpl-user-editor"], href: "/conversations/template/user" },
  { title: "Admin DM template", path: "Conversations / Templates", keywords: "admin direct message defaults access templates", oldIds: ["tpl-admin-editor"], href: "/conversations/template/admin" },
  { title: "Slack connection status", path: "System health", keywords: "slack connected health", href: "/system-health#sh-slack-status" },
  { title: "Engine harness status", path: "System health", keywords: "cli versions warm sessions engine health", href: "/system-health#sh-harness-status" },
  { title: "Organization-wide run API token", path: "API", keywords: "http deprecated legacy key", conditional: true, oldIds: ["set-apikey"], href: "/api-docs#api-legacy-token" },
];

export function movedSettingsPath(location) {
  if (location.pathname !== "/settings") return null;
  return destinations.find((item) => item.oldIds?.includes(location.hash.slice(1)))?.href;
}

export function createSettingsNavigation(openDestination) {
  const byId = (id) => document.getElementById(id);
  const view = byId("view-settings");
  const body = byId("settings-body");
  const sections = Array.from(body.querySelectorAll(".setsec"));
  const nav = byId("settings-nav");
  const picker = byId("settings-category");
  const input = byId("settings-search");
  const panel = byId("settings-search-panel");
  const results = byId("settings-results");
  const empty = byId("settings-no-results");
  let current = sections[0];
  let hasLegacyKey = false;
  let indexed = null;
  let activeQuery = "";
  let activeTarget = null;

  const prerequisiteHint = document.createElement("p");
  prerequisiteHint.className = "hint settings-prerequisite";
  prerequisiteHint.setAttribute("role", "status");
  body.addEventListener("change", () => prerequisiteHint.remove());

  function choose(sec, { hash = true, scroll = true } = {}) {
    const next = sections.find((el) => el.dataset.sec === sec);
    if (!next) return;
    prerequisiteHint.remove();
    activeTarget?.classList.remove("setting-found");
    current = next;
    input.value = "";
    renderSearch();
    for (const section of sections) section.hidden = section !== current;
    for (const link of nav.querySelectorAll("a")) {
      if (link.dataset.sec === sec) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    picker.value = sec;
    if (hash && window.location.pathname === "/settings") {
      window.history.replaceState(window.history.state, "", "/settings#set-" + sec);
    }
    if (scroll) {
      view.scrollTop = 0;
      if (matchMedia("(max-width: 760px)").matches) nav.parentElement.scrollIntoView({ block: "start" });
    }
  }

  function reveal(target, title) {
    if (!target?.isConnected) return;
    const section = target.closest(".setsec");
    if (!section) return;
    choose(section.dataset.sec, { scroll: false, hash: false });
    for (let el = target; el && el !== section; el = el.parentElement) {
      if (el.tagName === "DETAILS") el.open = true;
    }
    // Mode and entitlement controls own their visibility. A search must never enable a
    // feature or reveal a secret to show a result.
    const card = target.closest(".setcard");
    let focus = target.matches("input, select, textarea, button") ? target :
      target.querySelector("summary, input:not([type=hidden]), select, textarea, button");
    const targetId = target.id || focus?.id || card?.id || section.id;
    if (window.location.pathname === "/settings") {
      window.history.replaceState(window.history.state, "", "/settings#" + encodeURIComponent(targetId));
    }
    if (target.closest("[hidden]") || (focus && !focus.getClientRects().length)) {
      // Resolve nested settings from the outside in so the suggested control is visible.
      let prerequisite = card?.dataset.featureToggle;
      for (let el = target; el && el !== card; el = el.parentElement) {
        if (el.hidden) prerequisite = el.dataset.requiresSetting || el.dataset.modeControl || prerequisite;
      }
      focus = byId(prerequisite) || card?.querySelector("summary");
      if (focus && title && prerequisite) {
        prerequisiteHint.textContent = focus.type === "checkbox"
          ? "Turn this on to configure “" + title + "”."
          : "Change the mode to configure “" + title + "”.";
        (focus.closest("label") || focus).after(prerequisiteHint);
      }
    }
    if (focus && !focus.disabled) focus.focus({ preventScroll: true });
    const visible = focus?.getClientRects().length ? focus : card || target;
    visible.scrollIntoView({ block: "center" });
    activeTarget?.classList.remove("setting-found");
    activeTarget = visible.closest("label, summary, .field") || visible;
    activeTarget.classList.add("setting-found");
  }

  function renderSearch(limit = 40) {
    activeQuery = input.value.trim();
    const searching = Boolean(activeQuery);
    body.hidden = searching;
    panel.hidden = !searching;
    byId("settings-search-clear").hidden = !input.value;
    byId("settings-search-kbd").hidden = !!input.value;
    empty.hidden = true;
    results.replaceChildren();
    if (!searching) return;
    indexed ||= [...searchIndex(sections), ...destinations.filter((item) => !item.conditional || hasLegacyKey)];
    const hits = rankSettings(indexed, activeQuery);
    byId("settings-result-count").textContent = hits.length + (hits.length === 1 ? " matching setting" : " matching settings");
    empty.hidden = hits.length > 0;
    if (!hits.length) byId("settings-no-results-q").textContent = "“" + activeQuery + "”";
    for (const hit of hits.slice(0, limit)) {
      const button = document.createElement("button");
      button.type = "button";
      const path = document.createElement("small");
      path.textContent = hit.path;
      const name = document.createElement("strong");
      name.textContent = hit.title;
      button.append(path, name);
      button.addEventListener("click", () => hit.href ? openDestination(hit.href) : reveal(hit.target, hit.title));
      results.append(button);
    }
    if (hits.length > limit) {
      const more = document.createElement("button");
      more.type = "button";
      more.textContent = "Show more results";
      more.addEventListener("click", () => {
        renderSearch(limit + 40);
        results.children[limit]?.focus();
      });
      results.append(more);
    }
  }

  let group = "";
  let links, options;
  for (const section of sections) {
    if (section.dataset.group !== group) {
      group = section.dataset.group;
      links = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = group;
      links.append(heading);
      nav.append(links);
      options = document.createElement("optgroup");
      options.label = group;
      picker.append(options);
    }
    const sec = section.dataset.sec;
    const title = section.querySelector("h3").textContent;
    const link = document.createElement("a");
    link.href = "#set-" + sec;
    link.dataset.sec = sec;
    link.textContent = title;
    link.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      choose(sec);
    };
    links.append(link);
    const option = document.createElement("option");
    option.value = sec;
    option.textContent = title;
    options.append(option);
  }
  picker.onchange = () => choose(picker.value);
  input.oninput = () => { renderSearch(); view.scrollTop = 0; };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); results.querySelector("button")?.click(); }
    if (e.key === "ArrowDown") { e.preventDefault(); results.querySelector("button")?.focus(); }
    if (e.key === "Escape") { input.value = ""; renderSearch(); }
  };
  for (const id of ["settings-search-clear", "settings-no-results-clear"]) {
    byId(id).onclick = () => { input.value = ""; renderSearch(); input.focus(); };
  }
  document.addEventListener("keydown", (e) => {
    if (!view.classList.contains("active")) return;
    const typing = e.target.matches("input, textarea, select, [contenteditable=true]");
    if (!(e.key === "k" && (e.ctrlKey || e.metaKey)) && !(e.key === "/" && !typing && !e.altKey && !e.ctrlKey && !e.metaKey)) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  // Editors and option lists arrive asynchronously and can be repainted after saving.
  new MutationObserver(() => {
    indexed = null;
    if (activeQuery) renderSearch();
  }).observe(body, { childList: true, characterData: true, subtree: true });
  choose(current.dataset.sec, { hash: false, scroll: false });
  return {
    choose, reveal,
    setLegacyKeyAvailable(present) {
      hasLegacyKey = !!present;
      indexed = null;
      if (activeQuery) renderSearch();
    },
    enter(hash) {
      const linked = hash && byId(hash.slice(1));
      if (linked && body.contains(linked) && !linked.matches(".setsec")) return reveal(linked);
      const sec = sections.find((el) => "#" + el.id === hash) || current;
      choose(sec.dataset.sec, { hash: false, scroll: false });
    },
  };
}
