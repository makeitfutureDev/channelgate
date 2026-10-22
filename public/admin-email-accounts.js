// One email account editor, shared by the conversation scope (channel card → Connections) and the
// personal scope (user drawer) — see src/gateway/email-accounts.js.
//
// An email account is the mailbox's IMAP and SMTP settings entered once, on one form. Passwords are
// write-only like an environment secret: the list shows the address and both servers, there is no
// reveal call, and the password boxes are cleared the moment the account is stored. Saving an
// existing name with the password boxes empty keeps the stored passwords (a host or port change).
// Every save logs in to both servers first; an account that fails either login is not stored.
import { api } from "./admin-api.js";
import { confirmDialog } from "./admin-view.js";

const FIELDS = ["name", "address", "displayName", "imapHost", "imapPort", "imapUser", "imapPassword", "smtpHost", "smtpPort", "smtpUser", "smtpPassword"];

// `endpoint(name)` builds the per-account URL; PUT/DELETE hang off it and answer with the scope's
// full masked list.
export function mountEmailAccountEditor({
  root,
  endpoint,
  accounts = [],
  emptyText = "No email accounts.",
  removeBody = "Runs stop being able to read or send with this account. The passwords can't be recovered.",
  userName = () => "",
}) {
  const list = root.querySelector(".emac-list");
  const state = root.querySelector(".emac-state");
  const hint = root.querySelector(".emac-hint");
  const input = Object.fromEntries(FIELDS.map((field) => [field, root.querySelector(`.emac-${field}`)]));
  const sendToggle = root.querySelector(".emac-send");
  const saveButton = root.querySelector(".emac-save");
  const resetButton = root.querySelector(".emac-reset");
  let current = Array.isArray(accounts) ? accounts : [];

  const passwordPlaceholders = (existing) => {
    input.imapPassword.placeholder = existing ? "leave blank to keep the current password" : "IMAP password or app password";
    input.smtpPassword.placeholder = existing ? "leave blank to keep (blank = same as IMAP on a new account)" : "SMTP password — blank = same as IMAP";
  };
  const clearForm = () => {
    for (const field of FIELDS) input[field].value = "";
    if (sendToggle) sendToggle.checked = true;
    passwordPlaceholders(false);
  };

  const render = () => {
    if (state) state.textContent = current.length ? `${current.length} connected` : "none";
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
    for (const label of ["Account", "Address", "IMAP", "SMTP", "Send", "Verified", ""]) {
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
      name.textContent = entry.name;
      cell(name);
      cell(entry.displayName ? `${entry.displayName} <${entry.address}>` : entry.address, { className: "emac-address-cell", title: entry.address });
      cell(`${entry.imap.host}:${entry.imap.port}`, { className: "state", title: `${entry.imap.security === "tls" ? "TLS" : "STARTTLS"} · user ${entry.imap.user}` });
      cell(`${entry.smtp.host}:${entry.smtp.port}`, { className: "state", title: `${entry.smtp.security === "tls" ? "TLS" : "STARTTLS"} · user ${entry.smtp.user}` });
      cell(entry.sendEnabled === false ? "off" : "on", { className: "state" });
      const who = String(entry.setBy || "");
      const id = /^<@([A-Z0-9]+)>$/.exec(who)?.[1] || (/^[UW][A-Z0-9]+$/.test(who) ? who : "");
      cell(entry.verifiedAt ? new Date(entry.verifiedAt).toISOString().slice(0, 10) : "—", { className: "state", title: who ? `Set by ${id ? (userName(id) || id) : who}` : "" });
      const actions = row.insertCell();
      actions.className = "vars-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost emac-edit";
      edit.textContent = "Edit";
      edit.title = "Change the servers or replace a password";
      edit.addEventListener("click", () => {
        input.name.value = entry.name;
        input.address.value = entry.address;
        input.displayName.value = entry.displayName || "";
        input.imapHost.value = entry.imap.host;
        input.imapPort.value = String(entry.imap.port);
        input.imapUser.value = entry.imap.user;
        input.smtpHost.value = entry.smtp.host;
        input.smtpPort.value = String(entry.smtp.port);
        input.smtpUser.value = entry.smtp.user;
        input.imapPassword.value = "";
        input.smtpPassword.value = "";
        if (sendToggle) sendToggle.checked = entry.sendEnabled !== false;
        passwordPlaceholders(true);
        hint.textContent = `Editing ${entry.name}. Leave the password boxes blank to keep the stored passwords.`;
        input.imapHost.focus();
      });
      actions.appendChild(edit);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost emac-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const ok = await confirmDialog({ title: `Remove email account ${entry.name}?`, body: removeBody, confirmLabel: "Remove", danger: true });
        if (!ok) return;
        remove.disabled = true;
        try {
          const result = await api(endpoint(entry.name), { method: "DELETE" });
          current = result.accounts || [];
          hint.textContent = `Removed ${entry.name}.`;
          render();
        } catch (e) {
          remove.disabled = false;
          hint.textContent = e.message || "Couldn't remove that account.";
        }
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(table);
    list.appendChild(wrap);
  };
  render();
  passwordPlaceholders(false);

  // Account names are lowercase-with-dashes everywhere they are shown; fold as typed.
  input.name.addEventListener("input", () => {
    const folded = input.name.value.toLowerCase();
    if (folded !== input.name.value) input.name.value = folded;
    passwordPlaceholders(current.some((entry) => entry.name === folded.trim()));
  });
  // Typing the address fills the user names most providers expect, until edited by hand.
  input.address.addEventListener("input", () => {
    for (const field of ["imapUser"]) if (!input[field].dataset.touched) input[field].value = input.address.value.trim();
  });
  input.imapUser.addEventListener("input", () => { input.imapUser.dataset.touched = "1"; });
  resetButton?.addEventListener("click", () => { clearForm(); hint.textContent = ""; });

  saveButton.addEventListener("click", async () => {
    const name = input.name.value.trim().toLowerCase();
    const existing = current.some((entry) => entry.name === name);
    const body = {};
    for (const field of FIELDS) {
      if (field === "name") continue;
      const value = input[field].value;
      if (field.endsWith("Password")) { if (value) body[field] = value; } else body[field] = value.trim();
    }
    if (sendToggle) body.sendEnabled = sendToggle.checked;
    if (!name || !body.address || !body.imapHost || !body.imapUser || !body.smtpHost || (!existing && !body.imapPassword)) {
      hint.textContent = existing
        ? "Name, address, IMAP server, IMAP user and SMTP server are required."
        : "Name, address, IMAP server, IMAP user, IMAP password and SMTP server are required.";
      return;
    }
    saveButton.disabled = true;
    hint.textContent = "logging in to IMAP and SMTP, then saving…";
    try {
      const result = await api(endpoint(name), { method: "PUT", body: JSON.stringify(body) });
      current = result.accounts || [];
      clearForm();
      hint.textContent = `Connected ${name}: IMAP and SMTP logins verified. The agent can use it from the next message.`;
      render();
    } catch (e) {
      input.imapPassword.value = "";
      input.smtpPassword.value = "";
      hint.textContent = e.message || "Couldn't save that account.";
    } finally {
      saveButton.disabled = false;
    }
  });

  return { setAccounts(next) { current = Array.isArray(next) ? next : []; render(); } };
}

export function emailAccountEditorMarkup() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="emac-list"></div>
    <div class="emac-add">
      <div class="secret-add emac-row">
        <input class="emac-name" type="text" autocomplete="off" spellcheck="false" placeholder="name — e.g. work" maxlength="32" />
        <input class="emac-address" type="email" autocomplete="off" spellcheck="false" placeholder="address — name@example.com" />
        <input class="emac-displayName" type="text" autocomplete="off" placeholder="display name (optional)" maxlength="120" />
      </div>
      <div class="secret-add emac-row">
        <span class="emac-label">IMAP</span>
        <input class="emac-imapHost" type="text" autocomplete="off" spellcheck="false" placeholder="imap.example.com" />
        <input class="emac-imapPort" type="text" inputmode="numeric" autocomplete="off" placeholder="993 (TLS) · 143 (STARTTLS)" maxlength="5" />
        <input class="emac-imapUser" type="text" autocomplete="off" spellcheck="false" placeholder="IMAP user" />
        <input class="emac-imapPassword" type="password" autocomplete="new-password" placeholder="IMAP password or app password" />
      </div>
      <div class="secret-add emac-row">
        <span class="emac-label">SMTP</span>
        <input class="emac-smtpHost" type="text" autocomplete="off" spellcheck="false" placeholder="smtp.example.com" />
        <input class="emac-smtpPort" type="text" inputmode="numeric" autocomplete="off" placeholder="587 (STARTTLS) · 465 (TLS)" maxlength="5" />
        <input class="emac-smtpUser" type="text" autocomplete="off" spellcheck="false" placeholder="SMTP user — blank = same as IMAP" />
        <input class="emac-smtpPassword" type="password" autocomplete="new-password" placeholder="SMTP password — blank = same as IMAP" />
      </div>
      <div class="secret-add emac-row emac-actions">
        <label class="emac-send-label"><input class="emac-send" type="checkbox" checked /> allow sending</label>
        <button type="button" class="ghost emac-save">Test &amp; save account</button>
        <button type="button" class="ghost emac-reset">Clear form</button>
      </div>
    </div>
    <em class="state emac-hint"></em>`;
  return root;
}
