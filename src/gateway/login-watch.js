// The Claude login expiry has to reach a HUMAN, without a restart.
//
// The gateway authenticates every Claude run with the operator's own `claude` sign-in
// (src/gateway/claude-login.js). That login SESSION hard-expires every few weeks and only a new
// interactive sign-in moves the date — nothing the daemon does can renew it. Until this module the
// three-day warning was evaluated exactly twice: at boot, and whenever somebody typed `/status`. A
// daemon that has been up for a month therefore never warned at all, and the first symptom was
// Claude turns quietly failing over to Codex (which is precisely how one gateway spent hours on the
// wrong harness before anyone noticed).
//
// So: an hourly watch that resolves the login and, while it is inside the warning window or missing
// altogether, DMs every admin — once per UTC day per message class, remembered in the shared `_meta`
// table so a restart cannot turn the reminder into a spam loop. The LOG line is written on every
// tick (an operator reading journalctl should see the state continuously); the DM is the rationed
// half. A login that goes healthy again clears the class, so a later expiry notifies afresh.
//
// Nothing here touches token material: the resolver hands out paths, expiries and an opaque
// fingerprint, and this module forwards only the kind, the config dir, the expiry and the remedy.
import { getUsers } from "../config/store.js";
import { metaGet, metaSet } from "../db/index.js";
import { logEvent } from "../util/logger.js";
import { postDirectMessage } from "../platforms/notify.js";
import { resolveClaudeLogin, claudeLoginExpiryWarning, claudeLoginHint } from "./claude-login.js";

export const CLAUDE_LOGIN_WATCH_INTERVAL_MS = 60 * 60 * 1000;
// Not at boot: Slack connects a few seconds in, and an alert posted into a disconnected manager
// would be dropped and then rationed away for the rest of the day.
export const CLAUDE_LOGIN_WATCH_FIRST_DELAY_MS = 60 * 1000;

// Durable "already told the admins today" marker, in the same shared `_meta` key-value table the
// legacy-import flag and the follow-up digest slots use (no migration needed). One row, holding
// "<class>:<utc-day>" — being in SQLite rather than process memory is the whole point: a daemon
// restarted every hour must not DM every hour.
export const CLAUDE_LOGIN_ALERT_META_KEY = "claude_login_alert";

export function utcDayKey(atMs) {
  return new Date(atMs).toISOString().slice(0, 10);
}

export function formatAlertMark(alertClass, day) {
  return alertClass ? `${alertClass}:${day}` : "";
}

/**
 * The per-day decision, pure over the stored marker. Two message CLASSES ("expiring" | "missing"):
 * a class change is news even on a day we already wrote, and a healthy login resets the marker so
 * the next expiry notifies again.
 * @returns {{send:boolean, mark:string}} `mark` is what should be persisted after a successful send.
 */
export function decideLoginAlert({ mark = "", alertClass = "", day = "" } = {}) {
  if (!alertClass) return { send: false, mark: "" };
  const next = formatAlertMark(alertClass, day);
  if (String(mark || "") === next) return { send: false, mark: next };
  return { send: true, mark: next };
}

/**
 * Which class of trouble the resolved login is in, plus the one-line warning that goes to the log.
 * "" means healthy — a settings token and an API key never expire on their own, and a login already
 * dead comes back from the resolver as kind "none".
 */
export function classifyLogin(login, { warn = claudeLoginExpiryWarning, now = Date.now() } = {}) {
  if (!login || login.kind === "none") {
    return {
      alertClass: "missing",
      warning: String(login?.reason || login?.detail || `the gateway has no usable Claude login — ${claudeLoginHint()}`),
    };
  }
  const expiring = warn(login, { now: () => now });
  return expiring ? { alertClass: "expiring", warning: expiring } : { alertClass: "", warning: "" };
}

const utcStamp = (ms) => `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;

// The same instant in the gateway host's own timezone — "expires 2026-09-28 07:12 UTC" is not a
// time anybody plans around. "" when the host runs on UTC (the line would just repeat itself) or
// when the platform has no timezone data.
function localStamp(ms) {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ms));
    const g = (type) => parts.find((p) => p.type === type)?.value || "";
    const hour = g("hour") === "24" ? "00" : g("hour"); // some ICU builds render midnight as 24
    return `${g("year")}-${g("month")}-${g("day")} ${hour}:${g("minute")} ${tz}`;
  } catch {
    return "";
  }
}

/**
 * The DM body. Slack mrkdwn (the connector posts `text` as-is), and deliberately only: which login,
 * when it dies, and what to do about it.
 */
export function loginAlertText({ login, alertClass, warning = "", now = Date.now() } = {}) {
  const remedy = `Fix: ${claudeLoginHint()}. The gateway picks the new login up on its next turn — no restart needed.`;
  if (alertClass === "missing") {
    return [
      "🚨 *ChannelGate — no usable Claude login*",
      warning,
      "Claude turns fail (or fall back to Codex) until this is fixed.",
      remedy,
    ].filter(Boolean).join("\n");
  }
  const where = login?.configDir ? ` (\`${login.configDir}\`)` : "";
  const expiry = login?.expiresAt || 0;
  const local = expiry ? localStamp(expiry) : "";
  const hoursLeft = expiry ? Math.round((expiry - now) / 3_600_000) : 0;
  const head = expiry && expiry <= now
    ? "🚨 *ChannelGate — the Claude login has EXPIRED*"
    : `⚠️ *ChannelGate — the Claude login expires in ${hoursLeft}h*`;
  return [
    head,
    `The gateway authenticates Claude with the *${login?.kind || "unknown"}* login${where}.`,
    expiry ? `Expires: \`${utcStamp(expiry)}\`${local ? ` · \`${local}\`` : ""}.` : "",
    "Once it lapses, Claude turns fail (or fall back to Codex).",
    remedy,
  ].filter(Boolean).join("\n");
}

async function adminUserIds() {
  const users = await getUsers();
  return Object.entries(users).filter(([, u]) => u?.isAdmin).map(([userId]) => userId);
}

// Default delivery. Slack is the only surface that has admins today (user records are not
// platform-stamped), and it reaches them through the platform-neutral postDirectMessage — the same
// call the follow-up digest and the scheduler's acknowledgements use, so a second surface is a
// connector swap here and nothing else. Failure THROWS rather than returning null, because the tick
// counts a non-throwing delivery as delivered.
async function dmThroughSlack(slack, { userId, text }) {
  const connected = slack?.snapshot?.().connected;
  const client = connected ? slack.getClient?.() ?? null : null;
  if (!client) throw new Error("Slack is not connected");
  const posted = await postDirectMessage(client, { userId, text });
  if (!posted) throw new Error("could not open a DM");
  return posted;
}

/**
 * One pass. Exported so a test (and `startClaudeLoginWatch().tick()`) can drive it directly.
 * Every dependency is injectable: clock, resolver, warning, admin list, delivery, marker store.
 */
export async function claudeLoginWatchTick({
  slack = null,
  now = Date.now,
  log = console,
  resolve = resolveClaudeLogin,
  warn = claudeLoginExpiryWarning,
  admins = adminUserIds,
  notify = null,
  readMark = () => metaGet(CLAUDE_LOGIN_ALERT_META_KEY) || "",
  writeMark = (value) => metaSet(CLAUDE_LOGIN_ALERT_META_KEY, value),
} = {}) {
  const at = now();
  let login = null;
  try {
    login = resolve({ now });
  } catch (error) {
    log?.warn?.(`[claude-login] could not resolve the login: ${error?.message || error}`);
    return { alertClass: "", sent: 0, notified: false };
  }
  const { alertClass, warning } = classifyLogin(login, { warn, now: at });
  const mark = String(readMark() || "");

  if (!alertClass) {
    // Healthy again → forget the class, so a later expiry is news rather than a duplicate.
    if (mark) writeMark("");
    return { alertClass: "", sent: 0, notified: false, reset: Boolean(mark) };
  }

  // The log line is NOT rationed: an operator tailing the service should see the state on every
  // tick, exactly as the boot warning reads.
  log?.warn?.(`[claude-login] WARNING: ${warning}`);

  const decision = decideLoginAlert({ mark, alertClass, day: utcDayKey(at) });
  if (!decision.send) return { alertClass, sent: 0, notified: false };

  const text = loginAlertText({ login, alertClass, warning, now: at });
  const deliver = notify || ((recipient) => dmThroughSlack(slack, recipient));
  const recipients = await admins();
  let sent = 0;
  for (const userId of recipients) {
    try {
      await deliver({ userId, text, alertClass, login });
      sent += 1;
    } catch (error) {
      // One unreachable admin (or an unwired transport) must never cost the others their alert.
      log?.warn?.(`[claude-login] could not DM admin ${userId} — ${error?.message || error}`);
    }
  }

  if (sent > 0) {
    // Only once somebody actually heard it: a tick that reached nobody (Slack down, no admins yet)
    // stays due and retries on the next one.
    writeMark(decision.mark);
    logEvent("claude_login_alert", { kind: login?.kind || "none", alert: alertClass, admins: sent }).catch(() => {});
  } else {
    log?.warn?.(`[claude-login] no admin could be told (${recipients.length} admin(s)) — retrying on the next tick`);
  }
  return { alertClass, sent, notified: sent > 0, recipients: recipients.length };
}

/**
 * Start the watch: first pass a minute after boot, then hourly.
 * @returns {{tick:() => Promise<object>, stop:() => void}}
 */
export function startClaudeLoginWatch(options = {}) {
  const {
    intervalMs = CLAUDE_LOGIN_WATCH_INTERVAL_MS,
    firstDelayMs = CLAUDE_LOGIN_WATCH_FIRST_DELAY_MS,
    log = console,
  } = options;
  const tick = () => claudeLoginWatchTick(options);
  const safeTick = () => {
    tick().catch((error) => log?.error?.(`[claude-login] watch tick failed: ${error?.message || error}`));
  };
  let interval = null;
  const first = setTimeout(() => {
    interval = setInterval(safeTick, intervalMs);
    interval.unref?.();
    safeTick();
  }, firstDelayMs);
  first.unref?.();
  log?.log?.("[claude-login] login expiry watch started (hourly; DMs every admin once a day from three days out)");
  return {
    tick,
    stop() {
      clearTimeout(first);
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}
