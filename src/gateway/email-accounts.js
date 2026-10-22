// Email accounts: the rules. A person (personal scope) or a conversation (channel scope) connects
// a mailbox by giving its IMAP and SMTP settings — host, port, user, password for each — once, on
// one form, from the admin dashboard or the chat surface's settings. The daemon then reads and
// sends mail for that account through gateway tools (src/mcp/tools/email.js) with the mail
// libraries running in the daemon process: a container never sees a mailbox password, and the
// personal list is only ever resolved for the run of the person who owns it.
//
// The shape mirrors custom MCP connections (custom-mcps.js): a per-scope array keyed by a short
// name, stored on `meta.emailAccounts` (channel) and `user.emailAccounts` (person), with
// `listEmailAccounts()` the ONLY form a list may leave the process in. Passwords stay inside the
// record; they are never listed, never logged and pushed into every run's output redactor.
//
// Transport is always encrypted: implicit TLS ("tls": 993 / 465) or a mandatory STARTTLS upgrade
// ("starttls": 143 / 587). There is no cleartext option — a server that cannot upgrade fails the
// connection test and the account is not saved.
import { isValidDestinationHost } from "./egress/policy.js";
import { normalizeHost } from "./egress/rules.js";
import { classifyAddress } from "../web/ip-policy.js";
import { isIP } from "node:net";

export const EMAIL_ACCOUNT_LIMIT = 5;
export const EMAIL_ACCOUNT_SCOPES = Object.freeze({ channel: "channel", user: "personal" });
export const EMAIL_SECURITY = Object.freeze(["tls", "starttls"]);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ADDRESS_RE = /^[^\s@<>"'()[\],;:\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_ADDRESS_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_USER_LENGTH = 320;
const MAX_PASSWORD_BYTES = 1024;
export const DEFAULT_PORTS = Object.freeze({ imap: { tls: 993, starttls: 143 }, smtp: { tls: 465, starttls: 587 } });

function scopeLabel(scope) {
  const label = EMAIL_ACCOUNT_SCOPES[scope];
  if (!label) throw new Error(`Unknown email account scope "${scope}"`);
  return label;
}

/** Lowercase short name: letters, digits and hyphens, 1–32 chars ("work", "support", "personal"). */
export function normalizeEmailAccountName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("Account name must be 1–32 lowercase letters, digits or hyphens (\"work\", \"support\")");
  return name;
}

export function normalizeEmailAddress(value) {
  const address = String(value ?? "").trim();
  if (!address || address.length > MAX_ADDRESS_LENGTH || !ADDRESS_RE.test(address)) throw new Error("Email address must look like name@example.com");
  return address;
}

function normalizeDisplayName(value) {
  const name = String(value ?? "").replace(/[\r\n\t<>"]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length > MAX_DISPLAY_NAME_LENGTH) throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
  return name;
}

/** A public DNS name or IP literal — never loopback, link-local, private or metadata by name. */
export function normalizeMailHost(value, which) {
  const host = normalizeHost(value);
  if (!host || !isValidDestinationHost(host)) throw new Error(`${which} server must be a host name such as mail.example.com`);
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`${which} server refuses a loopback address`);
  if (isIP(host)) {
    const kind = classifyAddress(host);
    if (kind) throw new Error(`${which} server refuses a ${kind} address`);
  }
  return host;
}

export function normalizeMailPort(value, which, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${which} port must be a number between 1 and 65535`);
  return port;
}

/** "tls" | "starttls"; blank derives from the port (993/465 → tls, anything else → starttls). */
export function normalizeMailSecurity(value, port) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return port === 993 || port === 465 ? "tls" : "starttls";
  if (raw === "ssl" || raw === "ssl/tls" || raw === "implicit") return "tls";
  if (!EMAIL_SECURITY.includes(raw)) throw new Error("Security must be \"tls\" (993/465) or \"starttls\" (143/587)");
  return raw;
}

function normalizeMailUser(value, which) {
  const user = String(value ?? "").trim();
  if (!user) throw new Error(`${which} user name is required`);
  if (user.length > MAX_USER_LENGTH || /[\r\n\0]/.test(user)) throw new Error(`${which} user name is not valid`);
  return user;
}

function normalizeMailPassword(value, which) {
  const password = String(value ?? "");
  if (!password.trim()) return "";
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error(`${which} password is too long`);
  if (/[\r\n\0]/.test(password)) throw new Error(`${which} password contains a line break`);
  return password;
}

function cleanEndpoint(value) {
  if (!value || typeof value !== "object") return null;
  const port = Number(value.port);
  if (typeof value.host !== "string" || !value.host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof value.user !== "string" || !value.user || typeof value.password !== "string" || !value.password) return null;
  const security = EMAIL_SECURITY.includes(value.security) ? value.security : normalizeMailSecurity("", port);
  return { host: value.host, port, security, user: value.user, password: value.password };
}

// Drop anything that is not a complete, well-formed entry (a hand-edited row, a half-written
// record from an older build) so a bad row can never break listing, resolution or redaction.
function cleanEntries(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    if (typeof entry.address !== "string" || !ADDRESS_RE.test(entry.address)) continue;
    const imap = cleanEndpoint(entry.imap);
    const smtp = cleanEndpoint(entry.smtp);
    if (!imap || !smtp) continue;
    seen.add(name);
    out.push({
      name,
      address: entry.address,
      displayName: typeof entry.displayName === "string" ? entry.displayName : "",
      imap,
      smtp,
      sendEnabled: entry.sendEnabled !== false,
      setBy: typeof entry.setBy === "string" ? entry.setBy : "",
      setAt: typeof entry.setAt === "string" ? entry.setAt : "",
      verifiedAt: typeof entry.verifiedAt === "string" ? entry.verifiedAt : "",
    });
  }
  return out;
}

/**
 * Validate one form submission into a full record, merging an existing entry's passwords when the
 * form left them blank. SMTP user/password left blank take the IMAP ones (most providers share
 * them), which is what "fill the server settings once" means on the form. Returns the record
 * WITHOUT audit fields; `patchEmailAccounts` adds those.
 */
export function normalizeEmailAccountInput(input = {}, existing = null) {
  const name = normalizeEmailAccountName(input.name);
  const address = normalizeEmailAddress(input.address);
  const displayName = normalizeDisplayName(input.displayName);
  const imapHost = normalizeMailHost(input.imapHost ?? input.imap?.host, "IMAP");
  const imapSecurityRaw = input.imapSecurity ?? input.imap?.security ?? "";
  const imapPort = normalizeMailPort(input.imapPort ?? input.imap?.port, "IMAP", String(imapSecurityRaw).toLowerCase() === "starttls" ? DEFAULT_PORTS.imap.starttls : DEFAULT_PORTS.imap.tls);
  const imapSecurity = normalizeMailSecurity(imapSecurityRaw, imapPort);
  const imapUser = normalizeMailUser(input.imapUser ?? input.imap?.user, "IMAP");
  const imapPassword = normalizeMailPassword(input.imapPassword ?? input.imap?.password, "IMAP") || existing?.imap?.password || "";
  if (!imapPassword) throw new Error("IMAP password is required for a new account");

  const smtpHost = normalizeMailHost(input.smtpHost ?? input.smtp?.host, "SMTP");
  const smtpSecurityRaw = input.smtpSecurity ?? input.smtp?.security ?? "";
  const smtpPort = normalizeMailPort(input.smtpPort ?? input.smtp?.port, "SMTP", String(smtpSecurityRaw).toLowerCase() === "tls" ? DEFAULT_PORTS.smtp.tls : DEFAULT_PORTS.smtp.starttls);
  const smtpSecurity = normalizeMailSecurity(smtpSecurityRaw, smtpPort);
  const smtpUserRaw = String(input.smtpUser ?? input.smtp?.user ?? "").trim();
  const smtpUser = smtpUserRaw ? normalizeMailUser(smtpUserRaw, "SMTP") : imapUser;
  const smtpPasswordRaw = normalizeMailPassword(input.smtpPassword ?? input.smtp?.password, "SMTP");
  // A blank SMTP password means "same as IMAP" on a new account and "keep" on an update — unless
  // the IMAP password was just changed and the stored SMTP one equalled the old IMAP one, in which
  // case the person clearly uses one password for both and the new one applies to both.
  let smtpPassword = smtpPasswordRaw;
  if (!smtpPassword) {
    const storedSmtp = existing?.smtp?.password || "";
    const storedImap = existing?.imap?.password || "";
    smtpPassword = storedSmtp && storedSmtp !== storedImap ? storedSmtp : imapPassword;
  }
  const sendEnabled = input.sendEnabled === undefined || input.sendEnabled === null || input.sendEnabled === ""
    ? (existing ? existing.sendEnabled !== false : true)
    : !(input.sendEnabled === false || input.sendEnabled === "false" || input.sendEnabled === "0" || input.sendEnabled === "off" || input.sendEnabled === "no");
  return {
    name,
    address,
    displayName,
    imap: { host: imapHost, port: imapPort, security: imapSecurity, user: imapUser, password: imapPassword },
    smtp: { host: smtpHost, port: smtpPort, security: smtpSecurity, user: smtpUser, password: smtpPassword },
    sendEnabled,
  };
}

/** Find the stored entry a form update refers to (by name), or null. */
export function findEmailAccount(list, name) {
  let key;
  try { key = normalizeEmailAccountName(name); } catch { return null; }
  return cleanEntries(list).find((entry) => entry.name === key) || null;
}

/**
 * Add, update or remove one entry; returns the NEW list (the input is not mutated). `set` is a
 * record from normalizeEmailAccountInput (already merged with the existing passwords) — the store
 * verifies it against the servers BEFORE it reaches here.
 */
export function patchEmailAccounts(list, { set = null, remove = null, actor = "", now = new Date(), verifiedAt = "" } = {}) {
  const current = cleanEntries(list);
  if (remove != null) {
    const name = normalizeEmailAccountName(remove);
    if (!current.some((entry) => entry.name === name)) throw new Error(`No email account named "${name}"`);
    return current.filter((entry) => entry.name !== name);
  }
  if (!set) throw new Error("Nothing to change");
  const existing = current.find((entry) => entry.name === normalizeEmailAccountName(set.name)) || null;
  const record = normalizeEmailAccountInput(set, existing);
  if (!existing && current.length >= EMAIL_ACCOUNT_LIMIT) throw new Error(`At most ${EMAIL_ACCOUNT_LIMIT} email accounts here — remove one first`);
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const entry = { ...record, setBy: String(actor || ""), setAt: stamp, verifiedAt: verifiedAt ? String(verifiedAt) : stamp };
  return existing ? current.map((item) => (item.name === record.name ? entry : item)) : [...current, entry];
}

function maskEndpoint(endpoint) {
  return { host: endpoint.host, port: endpoint.port, security: endpoint.security, user: endpoint.user, hasPassword: true };
}

/** The masked shape — the ONLY form an email account list may leave the process in. */
export function listEmailAccounts(list, scope) {
  const label = scopeLabel(scope);
  return cleanEntries(list).map((entry) => ({
    name: entry.name,
    scope: label,
    address: entry.address,
    displayName: entry.displayName,
    imap: maskEndpoint(entry.imap),
    smtp: maskEndpoint(entry.smtp),
    sendEnabled: entry.sendEnabled,
    setBy: entry.setBy,
    setAt: entry.setAt,
    verifiedAt: entry.verifiedAt,
  }));
}

/** Every password in a list — what a run's output redactor must carry. */
export function emailAccountSecrets(list) {
  const out = [];
  for (const entry of cleanEntries(list)) {
    out.push(entry.imap.password);
    if (entry.smtp.password !== entry.imap.password) out.push(entry.smtp.password);
  }
  return out;
}

/**
 * The accounts ONE run may act on, with credentials: the channel's, plus the author's own when
 * the author is a verified person (the run API's named author is attribution only, so it gets no
 * personal scope — the same rule as composio-user and personal custom MCPs). Each carries `scope`
 * so a tool can tell the user which account it used.
 */
export function resolveEmailAccountsForRun({ channelList = [], userList = [], principalTrusted = true } = {}) {
  const out = cleanEntries(channelList).map((entry) => ({ ...entry, scope: "channel" }));
  if (principalTrusted) for (const entry of cleanEntries(userList)) out.push({ ...entry, scope: "personal" });
  return out;
}

/**
 * Pick one account from what a run may use. `selector` is a name, "personal/<name>",
 * "channel/<name>", or an email address; blank picks the only account when there is exactly one.
 * A bare name shared by a personal and a channel account is ambiguous and must be qualified.
 */
export function selectEmailAccount(accounts, selector = "") {
  const list = Array.isArray(accounts) ? accounts : [];
  const describe = (entry) => `${entry.scope}/${entry.name} (${entry.address})`;
  const raw = String(selector ?? "").trim().toLowerCase();
  if (!raw) {
    if (list.length === 1) return list[0];
    if (!list.length) throw new Error("No email account is connected here. Connect one under Settings → Email accounts (your own, or this conversation's).");
    throw new Error(`Several email accounts are available — pass \`account\`: ${list.map(describe).join(", ")}`);
  }
  const slash = raw.match(/^(personal|channel|my|mine|conversation)\/(.+)$/);
  if (slash) {
    const scope = slash[1] === "my" || slash[1] === "mine" ? "personal" : slash[1] === "conversation" ? "channel" : slash[1];
    const found = list.find((entry) => entry.scope === scope && (entry.name === slash[2] || entry.address.toLowerCase() === slash[2]));
    if (!found) throw new Error(`No ${scope} email account "${slash[2]}". Available: ${list.map(describe).join(", ") || "none"}`);
    return found;
  }
  const matches = list.filter((entry) => entry.name === raw || entry.address.toLowerCase() === raw);
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No email account "${raw}". Available: ${list.map(describe).join(", ") || "none"}`);
  throw new Error(`"${raw}" is both a personal and a channel account — pass ${matches.map(describe).join(" or ")}`);
}
