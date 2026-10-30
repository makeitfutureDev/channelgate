// Gateway-wide names for explicit, thread-scoped Slack model choices.
export const MODEL_SHORTCUT_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const MAX_MODEL_SHORTCUTS = 32;

// Families are stable shortcut names; exact versions come only from the engine catalogs.
const DEFAULT_SHORTCUT_FAMILIES = [
  ["astra", "codex", /^gpt-(\d+(?:\.\d+)*)-astra$/],
  ["sol", "codex", /^gpt-(\d+(?:\.\d+)*)-sol$/],
  ["terra", "codex", /^gpt-(\d+(?:\.\d+)*)-terra$/],
  ["fable", "claude", /^claude-fable-(\d+(?:-\d+)*)$/],
  ["opus", "claude", /^claude-opus-(\d+(?:-\d+)*)$/],
  ["sonet", "claude", /^claude-sonnet-(\d+(?:-\d+)*)$/],
];

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function defaultModelShortcuts(catalogs = {}) {
  const shortcuts = {};
  for (const [name, engine, pattern] of DEFAULT_SHORTCUT_FAMILIES) {
    let latest = null;
    for (const entry of catalogs[engine] || []) {
      const match = pattern.exec(String(entry?.value || ""));
      if (!match || /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(entry.value)) continue; // Ignore aliases, preview IDs and unrelated model families.
      const version = match[1].split(/[.-]/).map(Number);
      if (!latest || compareVersions(version, latest.version) > 0) latest = { model: entry.value, version };
    }
    if (latest) shortcuts[name] = { engine, model: latest.model };
  }
  return shortcuts;
}

export function modelShortcutsFromSettings(settings, catalogs = {}) {
  // A missing key inherits current catalog defaults. A saved list, including {}, is owned by
  // the administrator: upgrades must never overwrite custom pins or resurrect deleted names.
  if (!Object.hasOwn(settings || {}, "modelShortcuts")) return defaultModelShortcuts(catalogs);
  const raw = settings?.modelShortcuts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([name, target]) =>
    MODEL_SHORTCUT_NAME_RE.test(name) && target && typeof target === "object" &&
    typeof target.engine === "string" && typeof target.model === "string"
  ));
}

// Slack gives the bot mention as <@ID>; stripMentions leaves the colon at the start.
// Require a separating space before the task, so ":astraight" never selects ":astra".
export function parseModelShortcut(text) {
  const match = /^:\s*([a-z][a-z0-9_-]{0,23})(?=\s|$)\s*([\s\S]*)$/i.exec(String(text || "").trim());
  return match ? { name: match[1].toLowerCase(), task: match[2].trim() } : null;
}
