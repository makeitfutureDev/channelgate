// One write-only environment-secret editor, shared by all three scopes (config/scoped-env.js):
// a conversation's own secrets, the organization's, and one person's.
//
// The three differ only in which endpoint they talk to and what the copy says. Everything that
// makes them SAFE is identical and belongs in one place: the listing is names + last4 and there is
// no reveal call anywhere, the value box is cleared the moment the value is stored (a secret left
// sitting in a form field is one screen-share away from being read), and the name is folded to
// UPPER_SNAKE as it is typed because the store folds it on write either way.
import { api } from "./admin-api.js";
import { confirmDialog } from "./admin-view.js";

// `endpoint(name)` builds the per-variable URL; GET/PUT/DELETE all hang off it, and every mutation
// answers with the scope's full masked list so the caller never re-derives one.
export function mountSecretEditor({
  root,
  endpoint,
  vars = [],
  emptyText = "No variables set.",
  removeBody = "Runs stop receiving it. The value can't be recovered — you would have to issue a new one.",
  savedText = (name) => `Saved ${name}. It reaches the next run.`,
  namePlaceholder = "GH_TOKEN",
  disabled = false,
  // Slack user id → display name (the admin app's user directory); "" when unknown.
  userName = () => "",
}) {
  const list = root.querySelector(".secret-list");
  const state = root.querySelector(".secret-state");
  const hint = root.querySelector(".secret-hint");
  const nameInput = root.querySelector(".secret-name");
  const valueInput = root.querySelector(".secret-value");
  const saveButton = root.querySelector(".secret-save");
  const secretInput = root.querySelector(".secret-is-secret");
  const hostsInput = root.querySelector(".secret-hosts");
  let current = Array.isArray(vars) ? vars : [];

  nameInput.placeholder = namePlaceholder;
  for (const el of [nameInput, valueInput, secretInput, hostsInput, saveButton]) if (el) el.disabled = disabled;

  const render = () => {
    state.textContent = current.length ? `${current.length} set` : "none";
    list.textContent = "";
    if (current.length === 0) {
      const empty = document.createElement("em");
      empty.className = "state";
      empty.textContent = emptyText;
      list.appendChild(empty);
      return;
    }
    // One table: name, masked value, how containers receive it, where it may be sent, who set it.
    const wrap = document.createElement("div");
    wrap.className = "utable vars-table-wrap";
    const table = document.createElement("table");
    table.className = "vars-table";
    const head = table.createTHead().insertRow();
    for (const label of ["Name", "Value", "Type", "Servers", "Set by", "Updated", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const entry of current) {
      const row = body.insertRow();
      const cell = (text, { className = "", title = "" } = {}) => {
        const td = row.insertCell();
        if (className) td.className = className;
        if (title) td.title = title;
        if (text instanceof Node) td.appendChild(text); else td.textContent = text;
        return td;
      };
      const name = document.createElement("code");
      name.textContent = entry.name;
      cell(name);
      cell(`${entry.last4 ? `••••${entry.last4}` : "•••••••"}${entry.resolvable === false ? ` ⚠️ provider "${entry.provider}" can't be resolved` : ""}`, { className: "state" });
      // Egress (src/gateway/egress/): a SECRET reaches a container only as a placeholder the proxy
      // swaps on its servers — built-in or declared ones, or those an admin approved on first use;
      // a READABLE one is injected raw (with the reason: a password-looking name, a URL value, a choice).
      const secret = entry.protected === true;
      cell(secret ? "🔒 Secret" : "👁 Readable", { className: secret ? "vars-secret" : "vars-readable", title: secret ? "Programs see a stand-in; the real value is sent only to the servers listed." : entry.exposureReason || "Programs get the real value." });
      const hosts = (entry.hosts || []).join(", ");
      cell(secret ? (hosts || (entry.approval ? "asks an admin on first use" : "—")) : "—", { className: hosts ? "" : "state", title: entry.approval ? "Servers an admin approved. A new server asks once, in the conversation's thread." : "" });
      const who = String(entry.setBy || "");
      const id = /^<@([A-Z0-9]+)>$/.exec(who)?.[1];
      cell(id ? (userName(id) || id) : who || "—", { className: who ? "" : "state", title: id || "" });
      cell(entry.setAt ? new Date(entry.setAt).toISOString().slice(0, 10) : "—", { className: "state" });
      const actions = row.insertCell();
      actions.className = "vars-actions";
      if (!disabled) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost secret-remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: `Remove ${entry.name}?`, body: removeBody, confirmLabel: "Remove", danger: true,
          });
          if (!ok) return;
          remove.disabled = true;
          try {
            const result = await api(endpoint(entry.name), { method: "DELETE" });
            current = result.vars || [];
            hint.textContent = `Removed ${entry.name}.`;
            render();
          } catch (e) {
            remove.disabled = false;
            hint.textContent = e.message || "Couldn't remove that variable.";
          }
        });
        actions.appendChild(remove);
      }
    }
    wrap.appendChild(table);
    list.appendChild(wrap);
  };
  render();

  // Environment variables are UPPER_SNAKE everywhere they are shown, and the store folds case on
  // write — so fold it VISIBLY here too, as the admin types. Typing `gh_token` and having the row
  // come back as GH_TOKEN is a surprise; watching it become GH_TOKEN is not. The caret is restored
  // because assigning .value otherwise jumps it to the end mid-word.
  nameInput.addEventListener("input", () => {
    const upper = nameInput.value.toUpperCase();
    if (upper === nameInput.value) return;
    const { selectionStart, selectionEnd } = nameInput;
    nameInput.value = upper; // ASCII case folding is length-preserving, so the caret still fits
    try { nameInput.setSelectionRange(selectionStart, selectionEnd); } catch { /* selection unsupported here */ }
  });
  nameInput.addEventListener("blur", () => { nameInput.value = nameInput.value.trim().toUpperCase(); });

  saveButton.addEventListener("click", async () => {
    const name = nameInput.value.trim().toUpperCase();
    nameInput.value = name; // what gets sent is what the admin can see
    const value = valueInput.value;
    if (!name || !value) {
      hint.textContent = "Both a name and a value are required.";
      return;
    }
    saveButton.disabled = true;
    hint.textContent = "saving…";
    try {
      // Secret or not (hidden — the gateway still keeps an SMTP/database login readable and learns
      // where it may be sent through admin approvals — or readable). Optional "Allowed domains"
      // restricts a secret to exactly those domains; sent only when typed, so a rotation keeps the
      // stored list, and naming any makes the variable a secret.
      const hosts = hostsInput ? hostsInput.value.trim() : "";
      const exposure = hosts ? "hidden" : secretInput ? (secretInput.checked ? "hidden" : "readable") : "";
      const result = await api(endpoint(name), { method: "PUT", body: JSON.stringify({ value, ...(exposure ? { exposure } : {}), ...(hosts ? { hosts } : {}) }) });
      current = result.vars || [];
      valueInput.value = "";
      nameInput.value = "";
      if (secretInput) secretInput.checked = true;
      if (hostsInput) hostsInput.value = "";
      hint.textContent = savedText(name);
      render();
    } catch (e) {
      hint.textContent = e.message || "Couldn't save that variable.";
    } finally {
      saveButton.disabled = false;
    }
  });

  return { setVars(next) { current = Array.isArray(next) ? next : []; render(); } };
}

// The markup every scope's editor expects. Built here rather than repeated in index.html so a
// scope cannot ship with, say, a text-typed value box.
export function secretEditorMarkup() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="secret-list"></div>
    <div class="secret-add">
      <input class="secret-name" type="text" autocomplete="off" spellcheck="false" />
      <input class="secret-value" type="password" placeholder="value — stored, never shown again" autocomplete="new-password" />
      <label class="toggle" title="Programs see a stand-in; the real value is only sent to servers an admin approves. Email and database passwords stay usable automatically. Untick for plain configuration (an id, a region, a URL)."><input class="secret-is-secret" type="checkbox" checked /> Secret</label>
      <input class="secret-hosts" type="text" autocomplete="off" spellcheck="false" placeholder="Allowed domains (optional) — api.example.com" title="Restricts the secret to only these domains: the egress proxy swaps the real value in there and nowhere else, with no approval needed. Leave empty and each new server asks an admin once. Avoid multi-tenant suffixes such as *.vercel.app or *.github.io: they cover other customers' sites too." />
      <button type="button" class="ghost secret-save">Save variable</button>
    </div>
    <em class="state secret-hint"></em>`;
  return root;
}
