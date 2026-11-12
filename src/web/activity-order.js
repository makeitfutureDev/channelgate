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
