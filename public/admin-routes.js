// Canonical admin-page routes shared by the browser router and the Express shell fallback.
// Keep view ids aligned with the data-view attributes and #view-* section ids in index.html.
export const ADMIN_VIEWS = Object.freeze({
  dashboard: Object.freeze({ path: "/overview", title: "Overview" }),
  channels: Object.freeze({ path: "/conversations", title: "Conversations" }),
  users: Object.freeze({ path: "/users", title: "Users" }),
  schedules: Object.freeze({ path: "/automations", title: "Automations" }),
  audit: Object.freeze({ path: "/activity", title: "Activity" }),
  skills: Object.freeze({ path: "/skills", title: "Skills" }),
  api: Object.freeze({ path: "/api-docs", title: "HTTP run API" }),
  settings: Object.freeze({ path: "/settings", title: "Settings" }),
  "system-health": Object.freeze({ path: "/system-health", title: "System health" }),
});

export const ADMIN_VIEW_PATHS = Object.freeze(Object.values(ADMIN_VIEWS).map(({ path }) => path));
export const ADMIN_CONVERSATION_PATH_RE = /^\/conversations\/(channel|dm|group)\/([A-Za-z0-9._-]+)\/?$/;

const VIEW_BY_PATH = new Map(Object.entries(ADMIN_VIEWS).map(([view, { path }]) => [path, view]));

function normalizePath(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "");
  return path || "/";
}

export function viewForPath(pathname) {
  const path = normalizePath(pathname);
  if (path === "/") return "dashboard";
  if (conversationRouteForPath(path)) return "channels";
  return VIEW_BY_PATH.get(path) || null;
}

export function pathForView(view) {
  return ADMIN_VIEWS[view]?.path || ADMIN_VIEWS.dashboard.path;
}

export function titleForView(view) {
  return ADMIN_VIEWS[view]?.title || ADMIN_VIEWS.dashboard.title;
}

export function pathForConversation(kind, channelId) {
  const type = String(kind || "").toLowerCase();
  const id = String(channelId || "");
  if (!["channel", "dm", "group"].includes(type) || !/^[A-Za-z0-9._-]+$/.test(id)) return ADMIN_VIEWS.channels.path;
  return `${ADMIN_VIEWS.channels.path}/${type}/${id}`;
}

export function conversationKindForChannel(channel) {
  const type = String(channel?.type || "").toLowerCase();
  if (channel?.isDM || type === "im") return "dm";
  if (["group", "mpim"].includes(type)) return "group";
  return "channel";
}

export function conversationRouteForPath(pathname) {
  const match = ADMIN_CONVERSATION_PATH_RE.exec(normalizePath(pathname));
  if (!match) return null;
  const [, kind, channelId] = match;
  return {
    kind,
    channelId,
    key: `${kind === "dm" ? "dm" : "ch"}:${channelId}`,
  };
}
