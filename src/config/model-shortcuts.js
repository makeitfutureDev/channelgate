// Gateway-wide names for explicit, thread-scoped Slack model choices.
export const MODEL_SHORTCUT_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const MAX_MODEL_SHORTCUTS = 32;

export function modelShortcutsFromSettings(settings) {
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
