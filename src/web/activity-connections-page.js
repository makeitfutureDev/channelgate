// Kept self-contained: activityPage serializes this controller into its nonce script.
export function activityConnectionsBrowser({ base, csrf, connectionsNew = false }, browser) {
  const { document, fetch } = browser;
  let root, data, ended = false, listGeneration = 0, catalogGeneration = 0, timer;
  let apps = [], nextCursor = null, query = "", loadingApps = false, appsFailed = false, posting = false;
  let catalog, catalogStatus, more, search, selection, selectedApp;
  const node = (tag, className = "", text = "") => {
    const item = document.createElement(tag); item.className = className; item.textContent = text; return item;
  };
  const button = (text, action, className = "settings-button") => {
    const item = node("button", className, text); item.type = "button";
    item.addEventListener("click", action); return item;
  };
  function link(text, href, className = "settings-button") {
    const item = node("a", className, text); item.href = href; return item;
  }
  function stop() {
    ended = true; data = undefined; apps = []; selectedApp = undefined;
    listGeneration++; catalogGeneration++; browser.clearTimeout(timer);
    root.replaceChildren(node("p", "settings-error", "Your Activity session has ended. Open a new Dashboard link or sign in again."));
  }
  async function request(path, body) {
    const generation = listGeneration;
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CG-Request": "1", ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CG-CSRF": csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401 || response.status === 403) {
      if (generation === listGeneration) stop();
      throw new Error("Your Activity session has ended.");
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Connections could not be loaded. Please try again.");
    return value;
  }
  function heading(title, copy) {
    const head = node("div", "settings-row");
    const text = node("div", "settings-row-text"); text.append(node("h2", "", title), node("p", "settings-copy", copy));
    head.append(text); root.append(head); return head;
  }
  function accountRows() {
    const list = node("div", "connections-accounts");
    const groups = new Map();
    for (const account of Array.isArray(data.accounts) ? data.accounts : []) {
      const app = String(account.app || "Application");
      if (!groups.has(app)) groups.set(app, []); groups.get(app).push(account);
    }
    for (const [app, accounts] of groups) {
      const group = node("section"); group.append(node("h3", "", app));
      for (const account of accounts) {
        const row = node("div", "settings-row"), text = node("div", "settings-row-text");
        text.append(node("div", "settings-row-title", account.account || account.alias || "Connected account"));
        const details = [account.alias ? "Alias: " + account.alias : "", account.status || "Unknown status", account.isDefault ? "Default account" : ""].filter(Boolean);
        text.append(node("div", "settings-row-meta", details.join(" · "))); row.append(text); group.append(row);
      }
      list.append(group);
    }
    if (!groups.size) list.append(node("p", "settings-empty", "No applications are connected to your account yet."));
    root.append(list);
  }
  function renderList() {
    const head = heading("Your connections", "Applications connected to your account are available to your agent according to this gateway’s settings.");
    const actions = node("div", "settings-row-actions");
    actions.append(button("Refresh", () => { void load(); }));
    if (data.mode === "sdk" && data.canAdd) actions.append(link("Add connection", base + "/settings/connections/new", "settings-button primary"));
    head.append(actions);
    if (data.message) root.append(node("p", data.state === "error" ? "settings-error" : "settings-copy", data.message));
    if (data.mode === "personal") root.append(node("p", "settings-copy", "Your personal Composio token provides these applications. Add or manage applications in Composio, then refresh this page."));
    if (data.state === "unconfigured") {
      if (!data.message) root.append(node("p", "settings-copy", data.mode === "personal" ? "Add your personal Composio token below to show connected applications." : "Composio SDK is not configured. Ask an administrator to finish setup."));
      return;
    }
    // An unavailable provider is a failure state, not an empty account list.
    if (data.state === "error" || data.state === "unavailable") return;
    accountRows();
  }
  function controlsLocked() {
    if (search) search.disabled = posting || ended;
    if (more) more.disabled = posting || loadingApps || ended;
    for (const item of catalog?.querySelectorAll("button") || []) item.disabled = posting || ended || item.dataset.blocked === "true";
  }
  function renderApps() {
    catalog.replaceChildren();
    for (const app of apps) {
      const row = node("div", "settings-row"), text = node("div", "settings-row-text");
      text.append(node("div", "settings-row-title", app.name || app.slug), node("div", "settings-row-meta", app.description || app.slug));
      if (app.reason) text.append(node("p", "settings-copy", app.reason));
      const choose = button("Connect " + (app.name || app.slug), () => select(app), "settings-button");
      choose.dataset.blocked = String(app.canConnect !== true); choose.disabled = posting || app.canConnect !== true;
      row.append(text, choose); catalog.append(row);
    }
    if (!apps.length && !loadingApps && !appsFailed) catalog.append(node("p", "settings-empty", "No applications match your search."));
    more.hidden = !nextCursor; controlsLocked();
  }
  async function loadApps(append = false) {
    if (ended || posting) return;
    const generation = ++catalogGeneration, cursor = append ? nextCursor : null;
    loadingApps = true; appsFailed = false; catalogStatus.replaceChildren(node("span", "", "Loading applications…"));
    if (!append) { apps = []; nextCursor = null; catalog.replaceChildren(); }
    controlsLocked();
    try {
      const result = await request("/api/connections/apps?query=" + encodeURIComponent(query) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      if (ended || generation !== catalogGeneration) return;
      const seen = new Set(apps.map(app => app.slug));
      for (const app of Array.isArray(result.apps) ? result.apps : []) if (!seen.has(app.slug)) { apps.push(app); seen.add(app.slug); }
      nextCursor = result.nextCursor || null; catalogStatus.replaceChildren();
    } catch (error) {
      if (ended || generation !== catalogGeneration) return;
      appsFailed = true;
      catalogStatus.replaceChildren(node("span", "settings-error", error.message), button("Retry applications", () => { void loadApps(append); }));
    } finally {
      if (!ended && generation === catalogGeneration) { loadingApps = false; renderApps(); }
    }
  }
  function select(app) {
    if (posting || ended || app.canConnect !== true) return;
    selectedApp = app; selection.replaceChildren();
    const form = node("form", "settings-form"), label = node("label", "settings-field"), alias = node("input", "settings-input");
    alias.type = "text"; alias.name = "alias"; alias.maxLength = 80; alias.autocomplete = "off";
    alias.required = data.policy?.multiAccount !== false;
    label.append(node("span", "settings-label", "Account alias"), alias, node("span", "settings-hint", "Use a name you recognize, such as work or personal."));
    const submit = node("button", "settings-button primary", "Create connection link"); submit.type = "submit";
    const error = node("p", "settings-error"); error.setAttribute("role", "alert");
    const actions = node("div", "settings-form-actions"); actions.append(button("Cancel", () => { selectedApp = undefined; selection.replaceChildren(); }), submit);
    form.append(node("h3", "", "Connect " + (app.name || app.slug)), label, error, actions); selection.append(form);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (posting || ended || selectedApp !== app) return;
      if (alias.required && !alias.value.trim()) { error.textContent = "Enter an account alias."; return; }
      const generation = listGeneration;
      posting = true; error.textContent = ""; controlsLocked();
      for (const control of form.querySelectorAll("button,input")) control.disabled = true;
      try {
        const result = await request("/api/connections", { app: app.slug, alias: alias.value.trim() });
        if (ended || generation !== listGeneration) return;
        let url;
        try { url = new browser.URL(result.redirectUrl); } catch { throw new Error("The connection service returned an invalid authorization link."); }
        if (url.protocol !== "https:" || url.hostname !== "connect.composio.dev" || url.port || url.username || url.password) throw new Error("The connection service returned an invalid authorization link.");
        const authorize = link("Continue to " + (app.name || app.slug), url.href, "settings-button primary");
        authorize.target = "_blank"; authorize.rel = "noopener noreferrer";
        selection.replaceChildren(node("p", "settings-copy", "Open the authorization page to sign in and approve access. Return to your connections when finished."), authorize,
          link("View your connections", base + "/settings/connections"));
      } catch (failure) { if (!ended && generation === listGeneration) error.textContent = failure.message; }
      finally {
        if (!ended && generation === listGeneration) {
          posting = false; controlsLocked(); for (const control of form.querySelectorAll("button,input")) control.disabled = false;
        }
      }
    });
    alias.focus?.();
  }
  function renderNew() {
    const head = heading("Add a connection", "Choose an application and connect your own account.");
    head.append(link("Back to connections", base + "/settings/connections"));
    if (data.policy?.multiAccount) root.append(node("p", "settings-copy", "You can connect up to " + data.policy.maxAccountsPerToolkit + " accounts per application. Give each account a distinct alias."));
    search = node("input", "settings-input"); search.type = "search"; search.placeholder = "Search applications"; search.setAttribute("aria-label", "Search applications");
    catalogStatus = node("p", "settings-copy"); catalogStatus.setAttribute("role", "status"); catalogStatus.setAttribute("aria-live", "polite");
    catalog = node("div", "connections-catalog"); selection = node("div", "connections-selection");
    more = button("Load more applications", () => { if (!loadingApps) void loadApps(true); }); more.hidden = true;
    search.addEventListener("input", () => {
      query = search.value.trim(); catalogGeneration++; browser.clearTimeout(timer);
      selectedApp = undefined; selection.replaceChildren();
      timer = browser.setTimeout(() => { void loadApps(); }, 250);
    });
    root.append(search, selection, catalogStatus, catalog, more); void loadApps();
  }
  async function load() {
    if (ended || posting) return;
    const generation = ++listGeneration; catalogGeneration++; browser.clearTimeout(timer);
    data = undefined; apps = []; selectedApp = undefined; nextCursor = null;
    root.replaceChildren(node("p", "settings-copy", "Loading your connections…"));
    try {
      const result = await request("/api/connections");
      if (ended || generation !== listGeneration) return;
      data = result; root.replaceChildren();
      if (connectionsNew && data.mode === "sdk" && data.canAdd) renderNew(); else renderList();
    } catch (error) {
      if (!ended && generation === listGeneration) root.replaceChildren(node("p", "settings-error", error.message), button("Retry connections", () => { void load(); }));
    }
  }
  return {
    mount() {
      if (!root) { root = node("section", "settings-card connections-card"); root.setAttribute("aria-label", "Your application connections"); void load(); }
      return root;
    },
    refresh() {
      if (!root || ended) return;
      // A parent Settings token save/remove changes the inventory independently of this card.
      // Start a new generation now so an older inventory, catalog or authorization reply cannot restore it.
      posting = false; return load();
    },
  };
}
