export const DEFAULT_ACTIVITY_GROUP_ORDER = Object.freeze(["error", "waiting", "working", "idle"]);

export function validActivityGroupOrder(value) {
  return Array.isArray(value) && value.length === DEFAULT_ACTIVITY_GROUP_ORDER.length
    && new Set(value).size === value.length && value.every((status) => DEFAULT_ACTIVITY_GROUP_ORDER.includes(status));
}

export function activityGroupOrder(value) {
  return [...(validActivityGroupOrder(value) ? value : DEFAULT_ACTIVITY_GROUP_ORDER)];
}

export function activityGroupOrderVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Activity colour scheme preference: "system" follows the browser, the others pin one theme.
export const ACTIVITY_THEMES = Object.freeze(["system", "dark", "light"]);

export function activityTheme(value) {
  return ACTIVITY_THEMES.includes(value) ? value : "system";
}

export const DEFAULT_ACTIVITY_GROUPING = "channel";

export const ACTIVITY_GROUPINGS = Object.freeze(["status", "channel"]);

export function activityGrouping(value) {
  return ACTIVITY_GROUPINGS.includes(value) ? value : DEFAULT_ACTIVITY_GROUPING;
}

// Activity table columns: the viewer's own order and widths. Every id is a fixed column; widths
// are whole pixels within a per-column floor so a header can never collapse beyond reach.
// Actions keeps room for six 28px buttons and their five 4px gaps on desktop.
export const ACTIVITY_COLUMNS = Object.freeze(["conversation", "comment", "channel", "status", "last", "actions"]);
export const ACTIVITY_COLUMN_MIN_WIDTHS = Object.freeze({ conversation: 120, comment: 80, channel: 60, status: 80, last: 40, actions: 188 });
export const ACTIVITY_COLUMN_MAX_WIDTH = 1600;

export function validActivityColumnOrder(value) {
  return Array.isArray(value) && value.length === ACTIVITY_COLUMNS.length
    && new Set(value).size === value.length && value.every((id) => ACTIVITY_COLUMNS.includes(id));
}

export function validActivityColumnWidths(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([id, width]) => Object.hasOwn(ACTIVITY_COLUMN_MIN_WIDTHS, id)
    && Number.isSafeInteger(width) && width >= ACTIVITY_COLUMN_MIN_WIDTHS[id] && width <= ACTIVITY_COLUMN_MAX_WIDTH);
}

// A stored layout from an older column set (or a damaged record) falls back field by field.
export function activityColumns(value) {
  const order = validActivityColumnOrder(value?.order) ? [...value.order] : [...ACTIVITY_COLUMNS];
  const widths = validActivityColumnWidths(value?.widths) ? { ...value.widths } : {};
  return { order, widths };
}

// Private per-viewer comments on their own conversations, keyed like pins.
export const ACTIVITY_COMMENT_MAX = 500;
export const ACTIVITY_COMMENT_LIMIT = 2000;

export function normalizeActivityComment(value) {
  if (typeof value !== "string") return null;
  // One line: control characters (including newlines) become spaces; the result is trimmed.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return [...text].length <= ACTIVITY_COMMENT_MAX ? text : null;
}

export function activityComments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const comments = {};
  for (const [key, text] of Object.entries(value)) if (typeof text === "string" && text) comments[key] = text;
  return comments;
}
