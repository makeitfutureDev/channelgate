// The personal Activity dashboard as ONE installable web app (Chrome/Edge "Install app").
//
// Every Activity page lives under /activity/ and links the same manifest, so Chrome sees one
// app whatever page it was installed from. The app starts at the stable /activity/app launcher:
// a session's own URL (/activity/<id>) is random and its cookie is scoped to that path, so the
// launcher resumes the browser's latest live session (by id only; the dashboard still checks
// the session cookie) or falls back to passkey sign-in. Nothing here grants access.

import { logoColor } from "../config/appearance.js";

export const ACTIVITY_APP_START = "/activity/app";
export const ACTIVITY_APP_SCOPE = "/activity/";
export const ACTIVITY_MANIFEST_PATH = "/activity/manifest.webmanifest";
export const ACTIVITY_APP_COOKIE = "cg_activity_app";
export const ACTIVITY_APP_ICONS = Object.freeze({
  "icon-192.png": "activity-icon-192.png",
  "icon-512.png": "activity-icon-512.png",
  "icon-maskable-512.png": "activity-icon-maskable-512.png",
});

export const ACTIVITY_APP_COLORS = Object.freeze({ dark: "#080e0d", light: "#f6f7f4" });

/** Tags every Activity page carries in <head>: the manifest, the window colour and the icons. */
export function activityAppHead(color, theme = "system") {
  const query = `?color=${logoColor(color).slice(1)}`;
  return `<link rel="manifest" href="${ACTIVITY_MANIFEST_PATH}${query}">`
  + `<meta id="app-theme-dark" name="theme-color" content="${ACTIVITY_APP_COLORS[theme === "light" ? "light" : "dark"]}" media="(prefers-color-scheme: dark)">`
  + `<meta id="app-theme-light" name="theme-color" content="${ACTIVITY_APP_COLORS[theme === "dark" ? "dark" : "light"]}" media="(prefers-color-scheme: light)">`
  + `<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Activity">`
  + `<link rel="apple-touch-icon" href="${ACTIVITY_APP_SCOPE}icon-192.png${query}">`
  + `<link rel="icon" type="image/svg+xml" href="${ACTIVITY_APP_SCOPE}icon.svg${query}">`;
}

const cleanName = (value) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);

export function activityManifest({ agent = "", color } = {}) {
  const name = cleanName(agent), query = `?color=${logoColor(color).slice(1)}`;
  return {
    id: ACTIVITY_APP_START,
    name: name ? `${name} · Activity` : "ChannelGate Activity",
    short_name: name ? name.slice(0, 24) : "Activity",
    description: "Your live ChannelGate conversations, subscriptions and settings.",
    start_url: ACTIVITY_APP_START,
    scope: ACTIVITY_APP_SCOPE,
    display: "standalone",
    display_override: ["window-controls-overlay"],
    background_color: ACTIVITY_APP_COLORS.dark,
    theme_color: ACTIVITY_APP_COLORS.dark,
    // A Slack Activity link or bookmark opened while the app runs reuses its window.
    launch_handler: { client_mode: ["navigate-existing", "auto"] },
    icons: [
      { src: `${ACTIVITY_APP_SCOPE}icon-192.png${query}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${ACTIVITY_APP_SCOPE}icon-512.png${query}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `${ACTIVITY_APP_SCOPE}icon-maskable-512.png${query}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** The launcher cookie names the session id only — the id is already in the session's URL. */
export function activityAppCookie(id, { maxAgeSeconds, secure }) {
  return `${ACTIVITY_APP_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=${ACTIVITY_APP_START}; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function activityAppSessionId(cookieHeader) {
  const pair = String(cookieHeader || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${ACTIVITY_APP_COOKIE}=`));
  const id = pair?.slice(ACTIVITY_APP_COOKIE.length + 1) || "";
  return /^[A-Za-z0-9_-]{16}$/.test(id) ? id : "";
}
