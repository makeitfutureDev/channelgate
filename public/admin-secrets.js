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
}) {
  const list = root.querySelector(".secret-list");
  const state = root.querySelector(".secret-state");
  const hint = root.querySelector(".secret-hint");
  const nameInput = root.querySelector(".secret-name");
  const valueInput = root.querySelector(".secret-value");
  const saveButton = root.querySelector(".secret-save");
  let current = Array.isArray(vars) ? vars : [];

  nameInput.placeholder = namePlaceholder;
  for (const el of [nameInput, valueInput, saveButton]) el.disabled = disabled;

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
    for (const entry of current) {
      const row = document.createElement("div");
      row.className = "secret-row";
      const name = document.createElement("code");
      name.textContent = entry.name;
      const mask = document.createElement("em");
      mask.className = "state";
      const trail = [
        entry.setBy ? `set by ${entry.setBy}` : "",
        entry.setAt ? new Date(entry.setAt).toISOString().slice(0, 10) : "",
      ].filter(Boolean).join(" · ");
      mask.textContent = `${entry.last4 ? `••••${entry.last4}` : "•••••••"}${trail ? ` · ${trail}` : ""}`
        + (entry.resolvable === false ? ` · ⚠️ provider "${entry.provider}" can't be resolved by this build` : "");
      row.append(name, mask);
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
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
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
      const result = await api(endpoint(name), { method: "PUT", body: JSON.stringify({ value }) });
      current = result.vars || [];
      valueInput.value = "";
      nameInput.value = "";
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
      <button type="button" class="ghost secret-save">Save variable</button>
    </div>
    <em class="state secret-hint"></em>`;
  return root;
}
