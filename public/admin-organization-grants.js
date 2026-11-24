import { settingValuesEqual } from "./admin-state.js";

// This editor owns its draft. Settings and conversation templates write the same settings
// document, so a save can use a newer version only after comparing the grants it was based on.
export function mountOrganizationGrants({ api, buildEditor, loadSkillOptions, versionMoved, onSaved }) {
  const host = document.getElementById("org-grants-editor");
  const save = document.getElementById("org-grants-save");
  const discard = document.getElementById("org-grants-discard");
  const status = document.getElementById("org-grants-status");
  let editor;
  let initial;
  let stored;
  let busy = false;
  const dirty = () => !!editor && !settingValuesEqual(editor.getValues(), initial);
  function controls() {
    host.inert = busy;
    save.disabled = busy || !dirty();
    discard.hidden = !dirty();
    discard.disabled = busy;
  }
  function paint(settings) {
    stored = settings.accessGrants || {};
    editor = buildEditor(settings.accessGrants || {});
    host.replaceChildren(editor.el);
    initial = editor.getValues();
  }
  async function load({ discardDraft = false } = {}) {
    if (busy || (!discardDraft && dirty())) return;
    busy = true;
    controls();
    status.textContent = "Loading grants…";
    try {
      const [settings] = await Promise.all([api("/api/settings"), loadSkillOptions()]);
      paint(settings);
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      controls();
    }
  }
  host.addEventListener("change", () => {
    status.textContent = dirty() ? "Unsaved changes" : "";
    controls();
  });
  discard.addEventListener("click", () => load({ discardDraft: true }));
  save.addEventListener("click", async () => {
    if (busy || !dirty()) return;
    busy = true;
    controls();
    status.textContent = "Saving…";
    try {
      const latest = await api("/api/settings");
      if (!settingValuesEqual(latest.accessGrants || {}, stored)) {
        status.textContent = "Grants changed elsewhere. Discard changes to load the latest grants.";
        return;
      }
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ accessGrants: editor.getValues(), settingsVersion: latest.settingsVersion, connectSlack: false }),
      });
      versionMoved(latest.settingsVersion, saved.settingsVersion);
      paint(saved);
      onSaved(saved.accessGrants?.skills || []);
      status.textContent = "Grants saved";
    } catch (error) {
      status.textContent = error.status === 409 ? "Settings changed during save. Try saving again." : error.message;
    } finally {
      busy = false;
      controls();
    }
  });
  return { load };
}
