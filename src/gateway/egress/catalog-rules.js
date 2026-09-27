// Which environment secrets the egress proxy protects, and where each may be swapped.
//
// Why: a placeholder is only useful where the proxy knows to swap it. For the credentials the
// image's CLIs use, the gateway KNOWS the destinations (a GitHub token goes to api.github.com in
// an Authorization header), so those rules ship here; anything else is protected only when its
// owner declares "used on hosts" on the stored entry (config/channel-env.js validates it). A name
// with no rule is decided by its KIND (secretExposure below): a web-API-looking secret is HIDDEN —
// the container gets a placeholder, and the first time it is sent to a new server an admin approves
// that server once (an "approval" rule whose hosts are the entry's approvedHosts) — while one that
// is used outside HTTP (a mail or database password, a connection string, a signing key) stays
// READABLE: injected raw and flagged unprotected, or withheld under egressSecretsStrict.
//
// A rule is { hosts, headers, format } in the core's grant vocabulary (rules.js): hosts are exact
// names or one-level `*.suffix` wildcards, headers are lowercase names, format is one position or a
// list (bearer = `<scheme> <token>`, raw = the whole value, basic-password / basic-user = one half
// of `Basic base64(user:password)`).
//
// PURE: imports only the CLI catalog, so the config layer can derive "protected: yes/no" for a
// listing without importing the proxy or the database.
import { CLI_INTEGRATIONS } from "../../config/cli-catalog.js";

export const SWAP_FORMATS = Object.freeze(["bearer", "raw", "basic-password", "basic-user"]);
export const DEFAULT_RULE_HEADERS = Object.freeze(["authorization"]);
export const DEFAULT_RULE_FORMAT = Object.freeze(["bearer", "raw"]);
export const MAX_RULE_HOSTS = 16;
export const MAX_RULE_HEADERS = 8;

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Headers a rule may never name: the proxy's own routing and hop-by-hop fields.
const FORBIDDEN_HEADERS = new Set(["host", "connection", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "content-length"]);

// The relayed Claude login (scope `relay`): the placeholder in CLAUDE_CODE_OAUTH_TOKEN is swapped
// only in the Authorization header on the Anthropic API.
export const RELAY_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
export const RELAY_RULE = Object.freeze({ hosts: Object.freeze(["api.anthropic.com"]), headers: Object.freeze(["authorization"]), format: Object.freeze(["bearer"]) });
// The relayed Codex login (scope `relay`, the twin): the container's auth.json holds a JWT-SHAPED
// placeholder (placeholders.js) — the CLI parses its access token as a JWT — and the proxy replaces
// that WHOLE token with the live access token in the Authorization header on the OpenAI/ChatGPT
// endpoints Codex authenticates to. `jwt` is the only format it accepts: a bare `cgph_` there is
// never swapped. Kept in step with ENGINE_HOSTS.codex (engine-hosts.js).
export const CODEX_RELAY_SECRET_NAME = "CODEX_ACCESS_TOKEN";
export const CODEX_RELAY_RULE = Object.freeze({ hosts: Object.freeze(["api.openai.com", "chatgpt.com", "auth.openai.com"]), headers: Object.freeze(["authorization"]), format: Object.freeze(["jwt"]) });
const RELAY_RULES = Object.freeze({ [RELAY_SECRET_NAME]: RELAY_RULE, [CODEX_RELAY_SECRET_NAME]: CODEX_RELAY_RULE });

// The swap rule of a relay grant, by its secret name, or null for a name no relay uses.
export function relayRuleFor(secretName) {
  return Object.hasOwn(RELAY_RULES, secretName) ? RELAY_RULES[secretName] : null;
}

function freezeRule(id, { names, hosts, headers, format }) {
  return Object.freeze({
    id,
    names: Object.freeze([...names]),
    hosts: Object.freeze([...hosts]),
    headers: Object.freeze([...headers]),
    format: Object.freeze(Array.isArray(format) ? [...format] : [format]),
  });
}

// Built-in rules, first match wins. GitHub first: a PAT is used by `gh` (Authorization: token/Bearer)
// and by git over HTTPS (Basic with the token as the password half). The names are credential
// names only — GH_REPO, GH_HOST and GITHUB_REPOSITORY are configuration, and a placeholder there
// would be sent where nothing swaps it.
const GITHUB_RULE = freezeRule("github", {
  names: ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", /^GITHUB_PAT/, /^(GITHUB|GH)_[A-Z0-9_]*(TOKEN|PAT)$/],
  hosts: ["api.github.com", "github.com", "uploads.github.com", "*.githubusercontent.com"],
  headers: ["authorization"],
  format: ["bearer", "raw", "basic-password"],
});
const COMPOSIO_RULE = freezeRule("composio", {
  names: ["COMPOSIO_API_KEY"],
  hosts: ["backend.composio.dev", "*.composio.dev"],
  headers: ["x-api-key"],
  format: ["raw"],
});

export const SECRET_NAME_RULES = Object.freeze([
  GITHUB_RULE,
  ...Object.entries(CLI_INTEGRATIONS).filter(([, entry]) => entry.swap).map(([id, entry]) => freezeRule(id, entry.swap)),
  COMPOSIO_RULE,
]);

function nameMatches(pattern, name) {
  return pattern instanceof RegExp ? pattern.test(name) : pattern === name;
}

export function catalogRuleFor(name) {
  const key = String(name || "");
  return SECRET_NAME_RULES.find((rule) => rule.names.some((pattern) => nameMatches(pattern, key))) || null;
}

// ── Validation of an entry's own rule fields (written through channel-env.js) ────────────────

export function normalizeRuleHost(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
}

// A DNS name or a one-level `*.suffix` wildcard over one. IP literals are refused: the proxy's
// SSRF policy would refuse most of them anyway, and a secret "for 1.2.3.4" is not a declaration a
// human can audit.
export function isValidRuleHost(value) {
  const host = normalizeRuleHost(value);
  if (!host || host.length > 253) return false;
  const name = host.startsWith("*.") ? host.slice(2) : host;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

export function isValidRuleHeader(value) {
  const header = String(value ?? "").trim().toLowerCase();
  return HEADER_NAME.test(header) && !FORBIDDEN_HEADERS.has(header);
}

const listOf = (value) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : []).map((v) => String(v ?? "").trim()).filter(Boolean);

// Strict (write side): → the canonical { hosts?, headers?, format? } or throws a sentence for a
// human. `undefined` fields stay undefined (the caller keeps what was stored); an empty list or ""
// CLEARS the field.
export function assertValidSwapRuleFields({ hosts, headers, format } = {}) {
  const out = {};
  if (hosts !== undefined && hosts !== null) {
    const list = [...new Set(listOf(hosts).map(normalizeRuleHost))];
    if (list.length > MAX_RULE_HOSTS) throw new Error(`At most ${MAX_RULE_HOSTS} hosts per secret.`);
    const bad = list.find((host) => !isValidRuleHost(host));
    if (bad) throw new Error(`"${bad}" is not a host name — use a DNS name like api.example.com or a wildcard like *.example.com.`);
    out.hosts = list;
  }
  if (headers !== undefined && headers !== null) {
    const list = [...new Set(listOf(headers).map((h) => h.toLowerCase()))];
    if (list.length > MAX_RULE_HEADERS) throw new Error(`At most ${MAX_RULE_HEADERS} headers per secret.`);
    const bad = list.find((header) => !isValidRuleHeader(header));
    if (bad) throw new Error(`"${bad}" is not a header the proxy may swap a secret into.`);
    out.headers = list;
  }
  if (format !== undefined && format !== null) {
    const list = [...new Set(listOf(format).map((f) => f.toLowerCase()))];
    const bad = list.find((f) => !SWAP_FORMATS.includes(f));
    if (bad) throw new Error(`"${bad}" is not a secret format — use one of ${SWAP_FORMATS.join(", ")}.`);
    out.format = list;
  }
  return out;
}

// The channel meta's `egressRawHosts` (admin-set): hosts whose ports 22/5432/6543 get a raw CONNECT
// tunnel through the proxy (SSH, Postgres) while the channel's network is on. Strict, for the
// admin API; the proxy's policy re-filters tolerantly on read.
export const MAX_RAW_HOSTS = 16;
export function assertValidEgressRawHosts(value) {
  const list = [...new Set(listOf(value).map(normalizeRuleHost))];
  if (list.length > MAX_RAW_HOSTS) throw new Error(`At most ${MAX_RAW_HOSTS} raw hosts per channel.`);
  const bad = list.find((host) => !isValidRuleHost(host));
  if (bad) throw new Error(`"${bad}" is not a host name — use a DNS name like db.example.com or a wildcard like *.pooler.supabase.com.`);
  return list;
}

// Tolerant (read side): the same checks, dropping whatever is malformed instead of throwing.
export function normalizeSwapRuleFields(entry = {}) {
  const out = {};
  const hosts = Array.isArray(entry?.hosts) ? entry.hosts.map(normalizeRuleHost).filter(isValidRuleHost).slice(0, MAX_RULE_HOSTS) : [];
  if (hosts.length) out.hosts = [...new Set(hosts)];
  const headers = Array.isArray(entry?.headers) ? entry.headers.map((h) => String(h ?? "").trim().toLowerCase()).filter(isValidRuleHeader).slice(0, MAX_RULE_HEADERS) : [];
  if (headers.length) out.headers = [...new Set(headers)];
  const formats = (Array.isArray(entry?.format) ? entry.format : entry?.format ? [entry.format] : [])
    .map((f) => String(f ?? "").trim().toLowerCase()).filter((f) => SWAP_FORMATS.includes(f));
  if (formats.length) out.format = [...new Set(formats)];
  return out;
}

// ── Hidden or readable: the kind of a secret with no known destination ──────────────────────

// Secrets used OUTSIDE an HTTP request the proxy can see: a placeholder there would reach the
// program that needs the real value (an SMTP login, a database driver, an HMAC signer) and fail.
// Matched on name words (split on `_`), so MAKE_API_PASSWORD is readable and PASSAGE_TOKEN is not.
export const READABLE_NAME_WORDS = Object.freeze([
  "PASSWORD", "PASSWD", "PASS", "PWD", "SMTP", "IMAP", "POP3",
  "DB", "DATABASE", "DSN", "POSTGRES", "POSTGRESQL", "PG", "MYSQL", "MARIADB", "MONGO", "MONGODB", "REDIS", "AMQP", "RABBITMQ",
  "SIGNING", "HMAC", "ENCRYPTION", "SSH", "PGP", "GPG",
]);
// Word PAIRS that mark a readable secret where either word alone would not (a GitLab PRIVATE_TOKEN
// and a WEBHOOK_URL are web credentials; a PRIVATE_KEY and a WEBHOOK_SECRET sign things). An OAuth
// CLIENT_SECRET usually travels in a form body, which the proxy does not rewrite.
export const READABLE_NAME_PAIRS = Object.freeze([["PRIVATE", "KEY"], ["WEBHOOK", "SECRET"], ["CLIENT", "SECRET"], ["SECRET", "KEY"]]);
// Configuration that rides along in a secret store but is not a credential (a repo, an org or
// project id, a region): tools put it in URL paths and command lines where no swap happens, so a
// placeholder would only break them. Matched on the LAST word, so VERCEL_ORG_ID is readable and
// ORG_TOKEN is not.
export const IDENTIFIER_LAST_WORDS = Object.freeze([
  "ID", "IDS", "SID", "REPO", "REPOSITORY", "ORG", "ORGANIZATION", "TEAM", "PROJECT", "REGION", "ZONE", "HOST", "HOSTNAME", "PORT",
  "USER", "USERNAME", "EMAIL", "NAME", "ENV", "ENVIRONMENT", "URL", "URI", "DOMAIN", "BRANCH", "OWNER", "SLUG", "VERSION", "PATH", "BUCKET",
]);
// Whole-name matches for the few well-known signing credentials that carry none of the words above.
export const READABLE_NAMES = Object.freeze(["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "JWT_SECRET", "SESSION_SECRET", "APP_KEY", "SECRET_KEY_BASE"]);
// A value that is a URL — a connection string (postgres://, redis://, smtp://…) or a web address
// with the credential inside it (a Slack webhook URL) — is readable, whatever its name: a program
// needs the real address to connect at all, so a placeholder there could never reach the proxy.
const URL_VALUE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export const EXPOSURES = Object.freeze(["hidden", "readable"]);

// → { exposure: "hidden" | "readable", reason } for a secret the catalog and its entry give no
// destination. An explicit entry.exposure wins; otherwise name words, then the value's shape.
export function secretExposure(secretName, entry = null, value = undefined) {
  const own = String(entry?.exposure || "");
  if (EXPOSURES.includes(own)) return { exposure: own, reason: "set" };
  const name = String(secretName || "").toUpperCase();
  if (READABLE_NAMES.includes(name)) return { exposure: "readable", reason: "name" };
  const words = name.split("_").filter(Boolean);
  if (words.some((word) => READABLE_NAME_WORDS.includes(word))) return { exposure: "readable", reason: "name" };
  if (words.length && IDENTIFIER_LAST_WORDS.includes(words[words.length - 1])) return { exposure: "readable", reason: "identifier" };
  if (READABLE_NAME_PAIRS.some(([a, b]) => words.some((word, i) => word === a && words[i + 1] === b))) return { exposure: "readable", reason: "name" };
  const text = typeof value === "string" ? value : typeof entry?.value === "string" ? entry.value : "";
  if (URL_VALUE_RE.test(text.trim())) return { exposure: "readable", reason: "value" };
  return { exposure: "hidden", reason: "default" };
}

// An approval rule accepts its placeholder in ANY header and ANY query parameter, in any of the
// whole-value positions: the gateway does not know how this API authenticates, only that a human
// approved sending this secret to this server.
export const APPROVAL_HEADERS = Object.freeze(["*"]);
export const APPROVAL_QUERY = Object.freeze(["*"]);
export const APPROVAL_FORMATS = Object.freeze(["bearer", "raw", "basic-user", "basic-password"]);

// The servers an admin approved for an approval-rule secret (the entry's own approvedHosts).
export function approvedHostsOf(entry = null) {
  const list = Array.isArray(entry?.approvedHosts) ? entry.approvedHosts : [];
  return [...new Set(list.map(normalizeRuleHost).filter((host) => isValidRuleHost(host) && !host.startsWith("*.")))].slice(0, MAX_APPROVED_HOSTS);
}
export const MAX_APPROVED_HOSTS = 32;

// The swap rule for a secret NAME and its stored ENTRY, or null (readable: injected raw). The
// entry's own `hosts` wins outright (with its own headers/format, else the catalog's, else the
// defaults); with no hosts of its own the catalog rule applies, still refined by the entry's
// headers/format. With neither, a HIDDEN secret gets an approval rule (source "approval"): its
// hosts are only the servers an admin approved, and any other server asks (proxy.js). `value` is
// the resolved value when the caller has it (the value's shape can make a secret readable).
// An explicit `exposure: "readable"` on the entry returns null even for a catalog name.
export function rulesFor(secretName, entry = null, { value = undefined } = {}) {
  if (String(entry?.exposure || "") === "readable") return null;
  const own = normalizeSwapRuleFields(entry || {});
  const catalog = catalogRuleFor(secretName);
  if (own.hosts?.length) {
    return {
      hosts: own.hosts,
      headers: own.headers || [...(catalog?.headers || DEFAULT_RULE_HEADERS)],
      format: own.format || [...(catalog?.format || DEFAULT_RULE_FORMAT)],
      source: "entry",
    };
  }
  if (catalog) {
    return {
      hosts: [...catalog.hosts],
      headers: own.headers || [...catalog.headers],
      format: own.format || [...catalog.format],
      source: `catalog:${catalog.id}`,
    };
  }
  if (secretExposure(secretName, entry, value).exposure !== "hidden") return null;
  return {
    hosts: approvedHostsOf(entry),
    headers: [...APPROVAL_HEADERS],
    query: [...APPROVAL_QUERY],
    format: [...APPROVAL_FORMATS],
    source: "approval",
    approval: true,
  };
}
