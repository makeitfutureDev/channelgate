// One custom MCP connection editor, shared by the conversation scope (channel card → Connections)
// and the personal scope (user drawer) — see src/gateway/custom-mcps.js.
//
// A custom MCP is a remote server URL plus a Bearer token. The token is write-only like an
// environment secret: the list shows name, the server name the agent sees, the URL and the last
// four characters, there is no reveal call, and the token box is cleared the moment it is stored.
// Saving an existing name with the token box empty keeps the stored token (a URL change).
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
  const saveButton = root.querySelector(".cmcp-save");
  let current = Array.isArray(servers) ? servers : [];

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
    for (const label of ["Server", "URL", "Token", "Updated", ""]) {
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
      cell(`••••${entry.tokenLast4 || ""}`, { className: "state", title: "Bearer token (write-only)" });
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
      edit.title = "Change the URL or replace the token";
      edit.addEventListener("click", () => {
        nameInput.value = entry.name;
        urlInput.value = entry.url;
        tokenInput.value = "";
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
    tokenInput.placeholder = current.some((entry) => entry.name === folded.trim())
      ? "leave blank to keep the current token"
      : "Bearer token — stored, never shown again";
  });

  saveButton.addEventListener("click", async () => {
    const name = nameInput.value.trim().toLowerCase();
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    const existing = current.some((entry) => entry.name === name);
    if (!name || !url || (!existing && !token)) {
      hint.textContent = existing ? "A name and a URL are required." : "A name, a URL and a token are required.";
      return;
    }
    saveButton.disabled = true;
    hint.textContent = "checking and saving…";
    try {
      const result = await api(endpoint(name), { method: "PUT", body: JSON.stringify({ url, ...(token ? { token } : {}) }) });
      current = result.servers || [];
      const saved = current.find((entry) => entry.name === name);
      nameInput.value = "";
      urlInput.value = "";
      tokenInput.value = "";
      tokenInput.placeholder = "Bearer token — stored, never shown again";
      hint.textContent = savedText(saved?.serverName || name);
      render();
    } catch (e) {
      tokenInput.value = "";
      hint.textContent = e.message || "Couldn't save that server.";
    } finally {
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
      <input class="cmcp-name" type="text" autocomplete="off" spellcheck="false" placeholder="name — e.g. linear" maxlength="32" />
      <input class="cmcp-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://mcp.example.com/mcp" />
      <input class="cmcp-token" type="password" placeholder="Bearer token — stored, never shown again" autocomplete="new-password" />
      <button type="button" class="ghost cmcp-save">Save server</button>
    </div>
    <em class="state cmcp-hint"></em>`;
  return root;
}
