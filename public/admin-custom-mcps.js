// One custom MCP connection editor, shared by the conversation scope (channel card → Connections)
// and the personal scope (user drawer) — see src/gateway/custom-mcps.js.
//
// Authentication presets and named header/query values are write-only. Editing loads only
// field names; blank values preserve saved entries, and omitted rows remove them. Credential
// inputs are cleared after every save attempt and when switching the selected server.
import { api } from "./admin-api.js";
import { confirmDialog } from "./admin-view.js";

// `endpoint(name)` builds the per-server URL; PUT/DELETE hang off it and answer with the scope's
// full masked list.
export function mountCustomMcpEditor({
  root,
  endpoint,
  servers = [],
  emptyText = "No custom MCP servers.",
  removeBody = "Runs stop receiving this server. The token can't be recovered — you would have to issue a new one.",
  savedText = (serverName) => `Saved. Its tools reach the next run as mcp__${serverName}__…`,
  userName = () => "",
}) {
  const list = root.querySelector(".cmcp-list");
  const state = root.querySelector(".cmcp-state");
  const hint = root.querySelector(".cmcp-hint");
  const nameInput = root.querySelector(".cmcp-name");
  const urlInput = root.querySelector(".cmcp-url");
  const tokenInput = root.querySelector(".cmcp-token");
  const authInput = root.querySelector(".cmcp-auth");
  const saveButton = root.querySelector(".cmcp-save");
  let current = Array.isArray(servers) ? servers : [];

  const authLabel = (authType) => authType === "custom" ? "Custom headers and query parameters" : authType === "composio" ? "Composio consumer key" : "Bearer token";
  const groups = ["headers", "queryParams"];
  const rows = { headers: [], queryParams: [] };
  let selectedName = "";
  const clearValues = () => { tokenInput.value = ""; for (const group of groups) for (const row of rows[group]) row.value.value = ""; };
  const drawRows = (group) => {
    const container = root.querySelector(`.cmcp-${group}`);
    if (!container) return;
    container.textContent = "";
    for (const row of rows[group]) {
      const wrap = document.createElement("div"); wrap.className = "cmcp-pair";
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove";
      remove.addEventListener("click", () => { row.value.value = ""; rows[group] = rows[group].filter((item) => item !== row); drawRows(group); });
      wrap.appendChild(row.name); wrap.appendChild(row.value); wrap.appendChild(remove); container.appendChild(wrap);
    }
  };
  const addRow = (group, name = "") => {
    const key = document.createElement("input"); key.type = "text"; key.value = name; key.autocomplete = "off";
    key.placeholder = group === "headers" ? "Header name" : "Query parameter name"; key.setAttribute?.("aria-label", key.placeholder);
    const value = document.createElement("input"); value.type = "password"; value.autocomplete = "new-password";
    value.placeholder = name ? "Blank keeps saved value" : "Value — stored write-only"; value.setAttribute?.("aria-label", `${key.placeholder} value`);
    rows[group].push({ name: key, value }); drawRows(group);
  };
  const loadRows = (entry) => {
    clearValues(); selectedName = entry?.name || "";
    for (const group of groups) { rows[group] = []; for (const item of entry?.[group] || []) addRow(group, item.name); drawRows(group); }
  };
  for (const group of groups) root.querySelector(`.cmcp-add-${group}`)?.addEventListener("click", () => addRow(group));
  const tokenPlaceholder = () => {
    tokenInput.hidden = authInput.value === "custom";
    tokenInput.placeholder = current.some((entry) => entry.name === nameInput.value.trim().toLowerCase())
      ? "leave blank to keep the current token"
      : `${authLabel(authInput.value)} — stored, never shown again`;
  };

  const render = () => {
    if (state) state.textContent = current.length ? `${current.length} set` : "none";
    list.textContent = "";
    if (current.length === 0) {
      const empty = document.createElement("em");
      empty.className = "state";
      empty.textContent = emptyText;
      list.appendChild(empty);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "utable vars-table-wrap";
    const table = document.createElement("table");
    table.className = "vars-table";
    const head = table.createTHead().insertRow();
    for (const label of ["Server", "URL", "Authentication", "Credentials", "Updated", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const entry of current) {
      const row = body.insertRow();
      const cell = (content, { className = "", title = "" } = {}) => {
        const td = row.insertCell();
        if (className) td.className = className;
        if (title) td.title = title;
        if (content instanceof Node) td.appendChild(content); else td.textContent = content;
        return td;
      };
      const name = document.createElement("code");
      name.textContent = entry.serverName;
      cell(name, { title: `Stored as "${entry.name}"` });
      cell(entry.url, { className: "cmcp-url-cell", title: entry.url });
      cell(authLabel(entry.authType), { className: "state" });
      cell([...(entry.authType === "custom" ? [] : [`••••${entry.tokenLast4 || ""}`]), ...groups.flatMap((group) => (entry[group] || []).map((item) => `${group === "headers" ? "Header" : "Query"} ${item.name}: ••••${item.valueLast4 || ""}`))].join(" · "), { className: "state", title: `${authLabel(entry.authType)} (write-only)` });
      // Who set it rides in the tooltip: the card is narrow, and the URL needs the room.
      const who = String(entry.setBy || "");
      const id = /^<@([A-Z0-9]+)>$/.exec(who)?.[1] || (/^[UW][A-Z0-9]+$/.test(who) ? who : "");
      cell(entry.setAt ? new Date(entry.setAt).toISOString().slice(0, 10) : "—", { className: "state", title: who ? `Set by ${id ? (userName(id) || id) : who}` : "" });
      const actions = row.insertCell();
      actions.className = "vars-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost cmcp-edit";
      edit.textContent = "Edit";
      edit.title = "Change the URL, authentication, headers or query parameters";
      edit.addEventListener("click", () => {
        nameInput.value = entry.name;
        urlInput.value = entry.url;
        authInput.value = entry.authType || "bearer";
        loadRows(entry);
        tokenInput.hidden = authInput.value === "custom";
        tokenInput.placeholder = "leave blank to keep the current token";
        hint.textContent = `Editing ${entry.serverName}.`;
        urlInput.focus();
      });
      actions.appendChild(edit);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost cmcp-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const ok = await confirmDialog({ title: `Remove ${entry.serverName}?`, body: removeBody, confirmLabel: "Remove", danger: true });
        if (!ok) return;
        remove.disabled = true;
        try {
          const result = await api(endpoint(entry.name), { method: "DELETE" });
          current = result.servers || [];
          hint.textContent = `Removed ${entry.serverName}.`;
          render();
        } catch (e) {
          remove.disabled = false;
          hint.textContent = e.message || "Couldn't remove that server.";
        }
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(table);
    list.appendChild(wrap);
  };
  render();

  // Server names are lowercase-with-dashes everywhere they are shown; fold as typed.
  nameInput.addEventListener("input", () => {
    const folded = nameInput.value.toLowerCase();
    if (folded !== nameInput.value) nameInput.value = folded;
    const existing = current.find((entry) => entry.name === folded.trim());
    if (folded.trim() !== selectedName) loadRows(existing);
    if (existing) authInput.value = existing.authType || "bearer";
    tokenPlaceholder();
  });

  authInput.addEventListener("change", tokenPlaceholder);

  saveButton.addEventListener("click", async () => {
    const name = nameInput.value.trim().toLowerCase();
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    const existing = current.some((entry) => entry.name === name);
    if (!name || !url || (!existing && !token && authInput.value !== "custom")) {
      hint.textContent = !name || !url ? "A name and a URL are required." : "A token is required for this authentication type.";
      clearValues();
      return;
    }
    saveButton.disabled = true;
    hint.textContent = "checking and saving…";
    try {
      const result = await api(endpoint(name), { method: "PUT", body: JSON.stringify({ url, authType: authInput.value, ...(token ? { token } : {}), ...Object.fromEntries(groups.filter((group) => root.querySelector(`.cmcp-${group}`)).map((group) => [group, rows[group].map((row) => ({ name: row.name.value.trim(), ...(row.value.value ? { value: row.value.value } : {}) }))])) }) });
      current = result.servers || [];
      const saved = current.find((entry) => entry.name === name);
      loadRows();
      nameInput.value = "";
      urlInput.value = "";
      tokenInput.value = "";
      authInput.value = "bearer";
      tokenPlaceholder();
      hint.textContent = savedText(saved?.serverName || name);
      render();
    } catch (e) {
      tokenInput.value = "";
      hint.textContent = e.message || "Couldn't save that server.";
    } finally {
      clearValues();
      saveButton.disabled = false;
    }
  });

  return { setServers(next) { current = Array.isArray(next) ? next : []; render(); } };
}

export function customMcpEditorMarkup() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="cmcp-list"></div>
    <div class="secret-add cmcp-add">
      <input class="cmcp-name" aria-label="Server name" type="text" autocomplete="off" spellcheck="false" placeholder="name — e.g. linear" maxlength="32" />
      <input class="cmcp-url" aria-label="Server URL" type="url" autocomplete="off" spellcheck="false" placeholder="https://mcp.example.com/mcp" />
      <select class="cmcp-auth" aria-label="Authentication type">
        <option value="bearer">Bearer token</option>
        <option value="composio">Composio consumer key</option>
        <option value="custom">Custom headers and query parameters</option>
      </select>
      <input class="cmcp-token" aria-label="Token or consumer key" type="password" placeholder="Bearer token — stored, never shown again" autocomplete="new-password" />
      <button type="button" class="ghost cmcp-save">Save server</button>
    </div>
    <div class="cmcp-extra">
      <p class="state">Values are stored write-only. On edit, blank values keep the saved value; Remove deletes that entry. Put query parameters here, not in the server URL.</p>
      <div class="cmcp-headers"></div><button type="button" class="ghost cmcp-add-headers">Add header</button>
      <div class="cmcp-queryParams"></div><button type="button" class="ghost cmcp-add-queryParams">Add query parameter</button>
    </div>
    <em class="state cmcp-hint"></em>`;
  return root;
}
