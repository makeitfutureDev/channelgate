// Slack OAuth scope checker. On boot — and therefore after every `update_gateway` restart — the
// gateway compares the bot scopes the installed app CURRENTLY holds against the scopes the
// checked-in `slack-app-manifest.json` declares it needs, and flags any gap so an admin can add
// the missing scopes and reinstall. This is what catches "we shipped a feature that needs a new
// scope but the workspace's app wasn't reinstalled".
//
// Slack returns the granted scopes in the `x-oauth-scopes` response header on ANY Web API call,
// so a single `auth.test` reveals the live grant with no extra dependency. The manifest is the
// single source of truth for what's required, so this stays correct as future slices add scopes.
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayRoot } from "../config/paths.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(REPO_ROOT, "slack-app-manifest.json");
const stateFile = () => path.join(gatewayRoot(), "logs", "scope-check.json");

// Required bot scopes, read from the checked-in manifest. Returns [] if the manifest is missing or
// unparseable — a scope check that can't read the manifest must never crash boot.
export async function requiredBotScopes() {
  try {
    const j = JSON.parse(await readFile(MANIFEST, "utf8"));
    return (j?.oauth_config?.scopes?.bot || []).slice().sort();
  } catch {
    return [];
  }
}

// Live granted bot scopes, from the `x-oauth-scopes` header on an `auth.test` call.
async function grantedBotScopes(botToken) {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const header = res.headers.get("x-oauth-scopes") || "";
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "auth.test failed");
  return header.split(",").map((s) => s.trim()).filter(Boolean);
}

// Compare required vs granted bot scopes. Best-effort: never throws — returns
// { ok, missing[], required[], granted[], error }. `ok:false` means the check couldn't run
// (no token, unreadable manifest, or a Slack error), NOT that scopes are missing.
export async function checkBotScopes(botToken) {
  const required = await requiredBotScopes();
  if (!botToken) return { ok: false, missing: [], required, granted: [], error: "no bot token" };
  if (!required.length) return { ok: false, missing: [], required, granted: [], error: "manifest unreadable" };
  try {
    const granted = await grantedBotScopes(botToken);
    const grantedSet = new Set(granted);
    const missing = required.filter((s) => !grantedSet.has(s));
    return { ok: true, missing, required, granted, error: "" };
  } catch (e) {
    return { ok: false, missing: [], required, granted: [], error: e.message };
  }
}

// A Slack-mrkdwn message telling an admin exactly which scopes to add and how to apply them.
export function formatScopeWarning(missing) {
  const n = missing.length;
  const list = missing.map((s) => `• \`${s}\``).join("\n");
  return (
    `⚠️ *This Slack app is missing ${n} OAuth scope${n === 1 ? "" : "s"}* that the current gateway needs:\n` +
    `${list}\n\n` +
    `Some features won't work until ${n === 1 ? "it's" : "they're"} added. To fix:\n` +
    `1. Open <https://api.slack.com/apps|api.slack.com/apps> → this app → *App Manifest* and paste the latest \`slack-app-manifest.json\` (or add the scope${n === 1 ? "" : "s"} above under *OAuth & Permissions*).\n` +
    `2. *Reinstall to Workspace* to apply.`
  );
}

// Throttle so routine restarts don't re-spam admins: persist the last-seen missing set and only
// return true when it CHANGES to a non-empty set. Always records the current set (including the
// empty "all present" state) so a later regression to a previously-seen set still notifies.
export function shouldNotify(missing) {
  const key = missing.slice().sort().join(",");
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(stateFile(), "utf8"))?.missing ?? null;
  } catch {
    /* first run / unreadable — treat as changed */
  }
  const changed = key !== prev;
  try {
    writeFileSync(stateFile(), JSON.stringify({ missing: key, at: new Date().toISOString() }));
  } catch {
    /* best-effort; a failed write just means we may re-notify next boot */
  }
  return changed && missing.length > 0;
}
