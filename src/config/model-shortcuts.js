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
    MODEL_SHORTCUT_NAME_RE.test(name) && !effortShortcut(name) && target && typeof target === "object" &&
    typeof target.engine === "string" && typeof target.model === "string"
  ));
}

// Effort-only selectors: `@agent :high task` keeps the thread's model and pins just the effort.
// These names are reserved — a model shortcut can never be called `:low`, `:mid`, `:medium` or
// `:high`. `mid` is shorthand for `medium`.
const EFFORT_SHORTCUTS = Object.freeze({ low: "low", mid: "medium", medium: "medium", high: "high" });
export const EFFORT_SHORTCUT_NAMES = Object.freeze(Object.keys(EFFORT_SHORTCUTS));
export function effortShortcut(name) {
  const key = String(name || "").toLowerCase();
  return Object.hasOwn(EFFORT_SHORTCUTS, key) ? EFFORT_SHORTCUTS[key] : "";
}

// Slack gives the bot mention as <@ID>; stripMentions leaves the colon at the start.
// An optional second colon selects effort; otherwise the remainder is the task.
export function parseModelShortcut(text) {
  const match = /^:\s*([a-z][a-z0-9_-]{0,23})(?=\s|:|$)\s*([\s\S]*)$/i.exec(String(text || "").trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const task = match[2].trim();
  if (!task.startsWith(":")) return { name, task };
  const effort = /^:\s*(\S*)(?:\s+([\s\S]*))?$/.exec(task);
  const value = effort[1].toLowerCase();
  return { name, effort: effortShortcut(value) || value, task: (effort[2] || "").trim() };
}

// The selectors may follow the bot mention ANYWHERE in the message ("fix the build @agent :opus
// :high", "ok @agent :mid now do X"), not only at its start. The colon must touch the mention's
// trailing space and the name ("@agent: please" is ordinary text). Returns the message without
// the bot mention, with the selectors moved to the front where parseModelShortcut reads them —
// or null when no bot mention carries a selector (the caller strips mentions as before).
export function liftMentionSelector(text, botUserId) {
  const raw = String(text ?? "");
  if (!botUserId) return null;
  const id = String(botUserId).replace(/[^A-Z0-9]/gi, "");
  const name = "[a-z][a-z0-9_-]{0,23}";
  const match = new RegExp(`<@${id}(?:\\|[^>]+)?>[ \\t]*(:${name}(?:[ \\t]*:${name})?)(?=[\\s.,;!?)]|$)`, "i").exec(raw);
  if (!match) return null;
  const before = raw.slice(0, match.index).replace(/[ \t]+$/, "");
  const after = raw.slice(match.index + match[0].length).replace(/^[ \t]+/, "");
  const rest = `${before}${before && after ? " " : ""}${after}`
    .replace(new RegExp(`<@${id}(?:\\|[^>]+)?>`, "g"), "").trim();
  const selector = match[1].replace(/[ \t]+/g, " ");
  return `${selector}${rest ? ` ${rest}` : ""}`;
}
