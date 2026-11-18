// Kept self-contained: activityPage serializes this controller into its nonce script.
export function activityConnectionsBrowser({ base, csrf, connectionsNew = false }, browser) {
  const { document, fetch } = browser;
  let root, data, ended = false, listGeneration = 0, catalogGeneration = 0, timer;
  let apps = [], nextCursor = null, query = "", loadingApps = false, appsFailed = false, posting = false;
  let catalog, catalogStatus, pager, previous, next, pageLabel, search, selection, selectedApp, detailApp;
  const pageSize = 24;
  let page = 0, cursors = [null], pageLoaded = false;
  let tab = connectionsNew ? "all" : "connected";
  const names = { gmail: "Gmail", slack: "Slack", googlecalendar: "Google Calendar", googlesheets: "Google Sheets", googledrive: "Google Drive", googledocs: "Google Docs", microsoft_teams: "Microsoft Teams", hubspot: "HubSpot", linkedin: "LinkedIn", onedrive: "OneDrive", clickup: "ClickUp", sharepoint: "SharePoint", airtable: "Airtable", outlook: "Outlook", make: "Make" };
  const appName = slug => Object.prototype.hasOwnProperty.call(names, slug) ? names[slug] : String(slug || "Application").replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
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
    ended = true; data = undefined; apps = []; selectedApp = undefined; detailApp = undefined;
    listGeneration++; catalogGeneration++; browser.clearTimeout(timer);
    root.replaceChildren(node("p", "settings-error", "Your Activity session has ended. Open a new Dashboard link or sign in again."));
  }
  async function request(path, body, method = body === undefined ? "GET" : "POST") {
    const generation = listGeneration, mutation = method !== "GET";
    const response = await fetch(base + path, { method, credentials: "same-origin", cache: "no-store",
      headers: { "X-CG-Request": "1", ...(mutation ? { "X-CG-CSRF": csrf } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
  const accountsFor = slug => (Array.isArray(data?.accounts) ? data.accounts : []).filter(account => account.app === slug);
  function logoUrl(app) {
    if (typeof app.logo === "string" && app.logo.length <= 2048 && /^https:\/\/(logos|assets)\.composio\.dev\/[a-zA-Z0-9_./-]+$/.test(app.logo) && !app.logo.split("/").some(part => part === ".." || part === ".")) {
      try {
        const url = new browser.URL(app.logo);
        if (url.protocol === "https:" && ["logos.composio.dev", "assets.composio.dev"].includes(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/[a-zA-Z0-9_./-]+$/.test(url.pathname) && !url.pathname.split("/").some(part => part === ".." || part === ".")) return url.href;
      } catch { /* Use the canonical logo below when provider metadata is invalid. */ }
    }
    return typeof app.slug === "string" && /^[a-z0-9_][a-z0-9_-]{0,99}$/.test(app.slug) ? "https://logos.composio.dev/api/" + app.slug : null;
  }
  function icon(app, name) {
    const item = node("span", "connection-app-icon", name.split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase());
    item.setAttribute("aria-hidden", "true");
    const source = logoUrl(app);
    if (source) {
      const image = node("img", "connection-app-logo");
      image.alt = ""; image.setAttribute("aria-hidden", "true"); image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { item.replaceChildren(); item.textContent = name.split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase(); });
      image.src = source; item.replaceChildren(image);
    }
    return item;
  }
  function resetPages() { page = 0; cursors = [null]; apps = []; nextCursor = null; pageLoaded = false; }
  function connectedApps() {
    const slugs = [...new Set((Array.isArray(data?.accounts) ? data.accounts : []).map(account => account.app))];
    return slugs.map(slug => ({ slug, name: appName(slug) })).filter(app => (app.name + " " + app.slug).toLowerCase().includes(query.toLowerCase())).sort((left, right) => left.name.localeCompare(right.name));
  }
  function controlsLocked() {
    for (const item of root.querySelectorAll("button,input")) item.disabled = posting || ended || item.dataset.blocked === "true";
    if (previous) previous.disabled = posting || loadingApps || ended || page === 0;
    if (next) next.disabled = posting || loadingApps || ended || appsFailed || (tab === "all" ? !nextCursor : (page + 1) * pageSize >= connectedApps().length);
  }
  function renderApps() {
    if (!catalog || detailApp || ended) return;
    catalog.replaceChildren();
    let visible;
    if (tab === "connected") {
      const connected = connectedApps();
      page = Math.min(page, Math.max(0, Math.ceil(connected.length / pageSize) - 1));
      visible = connected.slice(page * pageSize, (page + 1) * pageSize);
    } else visible = apps;
    for (const app of visible) {
      const name = app.name || appName(app.slug), accounts = accountsFor(app.slug);
      const active = accounts.filter(account => String(account.status).toUpperCase() === "ACTIVE").length;
      const card = button("", () => { if (!posting && !ended) renderDetail(app); }, "connection-app-card");
      card.setAttribute("aria-label", "View " + name + " connections");
      const text = node("span", "connection-app-text");
      text.append(node("span", "connection-app-name", name), node("span", "connection-app-status", accounts.length ? accounts.length + (accounts.length === 1 ? " account" : " accounts") + " · " + active + " active" : "Not connected"));
      card.append(icon(app, name), text); catalog.append(card);
    }
    if (!visible.length && !loadingApps && !appsFailed) catalog.append(node("p", "settings-empty", tab === "all" && (page || nextCursor) ? "No applications on this page." : query ? "No applications match your search." : tab === "connected" ? "No applications are connected to your account yet." : "No applications are available."));
    if (pageLabel) pageLabel.textContent = "Page " + (page + 1);
    if (pager) pager.hidden = tab === "connected" ? connectedApps().length <= pageSize : !page && !nextCursor && !loadingApps;
    controlsLocked();
  }
  async function loadApps(targetPage = page) {
    if (ended || posting || detailApp || tab !== "all") return;
    const generation = ++catalogGeneration, cursor = cursors[targetPage];
    page = targetPage; pageLoaded = false;
    loadingApps = true; appsFailed = false; catalogStatus.replaceChildren(node("span", "", "Loading applications…"));
    apps = []; nextCursor = null; renderApps();
    try {
      const result = await request("/api/connections/apps?query=" + encodeURIComponent(query) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      if (ended || generation !== catalogGeneration) return;
      const seen = new Set();
      for (const app of Array.isArray(result.apps) ? result.apps : []) if (app && typeof app.slug === "string" && !seen.has(app.slug) && apps.length < pageSize) { apps.push(app); seen.add(app.slug); }
      nextCursor = typeof result.nextCursor === "string" && result.nextCursor !== cursor && !cursors.slice(0, targetPage + 1).includes(result.nextCursor) ? result.nextCursor : null;
      cursors = cursors.slice(0, targetPage + 1);
      if (nextCursor) cursors.push(nextCursor);
      pageLoaded = true; catalogStatus.replaceChildren();
    } catch (error) {
      if (ended || generation !== catalogGeneration) return;
      appsFailed = true;
      catalogStatus.replaceChildren(node("span", "settings-error", error.message), button("Retry applications", () => { void loadApps(targetPage); }));
    } finally {
      if (!ended && generation === catalogGeneration) { loadingApps = false; renderApps(); }
    }
  }
  function renderOverview() {
    if (ended || posting) return;
    detailApp = undefined; selectedApp = undefined; catalogGeneration++; browser.clearTimeout(timer); loadingApps = false; appsFailed = false;
    root.replaceChildren();
    const head = heading("Connections", "Choose an application to view and manage your connected accounts.");
    const actions = node("div", "settings-row-actions");
    actions.append(button("Refresh", () => { void load(); }));
    if (data.mode === "sdk" && data.canAdd && !connectionsNew) actions.append(link("Add connection", base + "/settings/connections/new", "settings-button primary"));
    head.append(actions);
    if (data.message) root.append(node("p", data.state === "error" ? "settings-error" : "settings-copy", data.message));
    if (data.mode === "personal") root.append(node("p", "settings-copy", "Your personal Composio token provides these applications. Add applications in Composio, then refresh this page. Open an app to manage its connected accounts."));
    if (data.state === "unconfigured") {
      if (!data.message) root.append(node("p", "settings-copy", data.mode === "personal" ? "Add your personal Composio token below to show connected applications." : "Composio SDK is not configured. Ask an administrator to finish setup."));
      return;
    }
    if (data.state === "error" || data.state === "unavailable") return;
    if (data.mode !== "sdk") tab = "connected";
    const toolbar = node("div", "connections-toolbar"), tabs = node("div", "connections-tabs"); tabs.setAttribute("aria-label", "Application views");
    const connectedCount = new Set((Array.isArray(data.accounts) ? data.accounts : []).map(account => account.app)).size;
    const connected = button("Connected (" + connectedCount + ")", () => { if (posting || ended) return; tab = "connected"; query = ""; resetPages(); renderOverview(); });
    connected.setAttribute("aria-pressed", String(tab === "connected")); tabs.append(connected);
    if (data.mode === "sdk") {
      const all = button("All apps", () => { if (posting || ended) return; tab = "all"; query = ""; resetPages(); renderOverview(); });
      all.setAttribute("aria-pressed", String(tab === "all")); tabs.append(all);
    }
    search = node("input", "settings-input connections-search"); search.type = "search"; search.placeholder = "Search applications"; search.value = query; search.setAttribute("aria-label", "Search applications");
    catalogStatus = node("p", "settings-copy"); catalogStatus.setAttribute("role", "status"); catalogStatus.setAttribute("aria-live", "polite");
    catalog = node("div", "connections-grid"); selection = node("div", "connections-selection");
    pager = node("div", "connections-pagination"); pager.setAttribute("aria-label", "Applications pagination");
    previous = button("Previous", () => { if (posting || ended || loadingApps || page === 0) return; if (tab === "all") void loadApps(page - 1); else { page--; renderApps(); } });
    next = button("Next", () => {
      if (posting || ended || loadingApps || appsFailed) return;
      if (tab === "all") { if (nextCursor) void loadApps(page + 1); }
      else if ((page + 1) * pageSize < connectedApps().length) { page++; renderApps(); }
    });
    pageLabel = node("span", "connections-page-label", "Page " + (page + 1)); pageLabel.setAttribute("aria-live", "polite");
    pager.append(previous, pageLabel, next);
    search.addEventListener("input", () => {
      if (posting || ended) return;
      query = search.value.trim(); catalogGeneration++; browser.clearTimeout(timer); loadingApps = false; appsFailed = false; resetPages();
      if (tab === "connected") renderApps();
      else { catalog.replaceChildren(); catalogStatus.replaceChildren(); pager.hidden = true; timer = browser.setTimeout(() => { void loadApps(); }, 250); }
    });
    toolbar.append(tabs, search); root.append(toolbar, catalogStatus, catalog, pager);
    if (tab === "all" && !pageLoaded) void loadApps(); else renderApps();
  }
  function renderDetail(app) {
    if (posting || ended) return;
    catalogGeneration++; browser.clearTimeout(timer); loadingApps = false; detailApp = app; selectedApp = undefined;
    root.replaceChildren();
    root.append(button("Back to apps", () => { if (!posting && !ended) renderOverview(); }));
    const name = app.name || appName(app.slug), head = heading(name, app.description || "Manage your connected accounts for " + name + ".");
    head.className += " connection-detail"; head.children[0].children[0].prepend?.(icon(app, name));
    if (data.mode === "sdk" && data.canAdd) {
      const canConnect = app.canConnect !== false;
      const connect = button("Connect new", () => { if (canConnect) select({ ...app, name, canConnect: true }); }, "settings-button primary");
      connect.dataset.blocked = String(!canConnect); connect.disabled = !canConnect; head.append(connect);
    }
    if (app.reason) root.append(node("p", "settings-copy", app.reason));
    root.append(node("h3", "", "Your connected accounts"));
    const accounts = accountsFor(app.slug), list = node("div", "connections-accounts");
    for (const account of accounts) {
      const row = node("div", "settings-row connection-account-row"), text = node("div", "settings-row-text");
      text.append(node("div", "settings-row-title", account.alias || account.account || "Connected account"));
      const details = [account.account && account.account !== account.alias ? account.account : "", account.status || "Unknown status", account.isDefault ? "Default account" : ""].filter(Boolean);
      text.append(node("div", "settings-row-meta", details.join(" · "))); row.append(text);
      if (account.canDelete === true && account.id) {
        const actions = node("div", "connection-account-actions"), confirm = node("div", "connection-delete-confirm");
        const generation = listGeneration;
        actions.append(button("Delete connection", () => {
          if (posting || ended || generation !== listGeneration) return;
          confirm.replaceChildren(node("p", "settings-copy", "Delete " + (account.alias || account.account || "this connection") + "? Your agent will lose access through this connection."));
          const failure = node("p", "settings-error"); failure.setAttribute("role", "alert");
          confirm.append(failure, button("Cancel deletion", () => { if (!posting) confirm.replaceChildren(); }), button("Confirm deletion", async () => {
            if (posting || ended || generation !== listGeneration) return;
            posting = true; failure.textContent = ""; controlsLocked();
            try {
              await request("/api/connections/" + encodeURIComponent(account.id), undefined, "DELETE");
              if (ended || generation !== listGeneration) return;
              posting = false; await load(app);
            } catch (error) { if (!ended && generation === listGeneration) failure.textContent = error.message; }
            finally { if (!ended && generation === listGeneration) { posting = false; controlsLocked(); } }
          }, "settings-button danger"));
        }));
        row.append(actions); list.append(row, confirm);
      } else list.append(row);
    }
    if (!accounts.length) list.append(node("p", "settings-empty", "You have no connected accounts for this application."));
    selection = node("div", "connections-selection"); root.append(list, selection); controlsLocked();
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
    const actions = node("div", "settings-form-actions"); actions.append(button("Cancel", () => { if (!posting) { selectedApp = undefined; selection.replaceChildren(); } }), submit);
    form.append(node("h3", "", "Connect " + (app.name || app.slug)), label, error, actions); selection.append(form);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (posting || ended || selectedApp !== app) return;
      if (alias.required && !alias.value.trim()) { error.textContent = "Enter an account alias."; return; }
      const generation = listGeneration;
      posting = true; error.textContent = ""; controlsLocked();
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
      finally { if (!ended && generation === listGeneration) { posting = false; controlsLocked(); } }
    });
    alias.focus?.();
  }
  async function load(returnToApp) {
    if (ended || posting) return;
    const generation = ++listGeneration; catalogGeneration++; browser.clearTimeout(timer);
    data = undefined; selectedApp = undefined; detailApp = undefined; resetPages();
    root.replaceChildren(node("p", "settings-copy", "Loading your connections…"));
    try {
      const result = await request("/api/connections");
      if (ended || generation !== listGeneration) return;
      data = result;
      if (returnToApp && !["unconfigured", "error", "unavailable"].includes(data.state)) renderDetail(returnToApp); else renderOverview();
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
      // Token changes invalidate older inventory, catalog and mutation replies immediately.
      posting = false; return load();
    },
  };
}
