// Which environment secrets the egress proxy protects, and where each may be swapped.
//
// Why: a placeholder is only useful where the proxy knows to swap it. For the credentials the
// image's CLIs use, the gateway KNOWS the destinations (a GitHub token goes to api.github.com in
// an Authorization header), so those rules ship here; anything else is protected only when its
// owner declares "used on hosts" on the stored entry (config/channel-env.js validates it). A name
// with no rule is injected raw and flagged unprotected — or withheld under egressSecretsStrict.
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

// The swap rule for a secret NAME and its stored ENTRY, or null (unprotected). The entry's own
// `hosts` wins outright (with its own headers/format, else the catalog's, else the defaults); with
// no hosts of its own the catalog rule applies, still refined by the entry's headers/format.
export function rulesFor(secretName, entry = null) {
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
  if (!catalog) return null;
  return {
    hosts: [...catalog.hosts],
    headers: own.headers || [...catalog.headers],
    format: own.format || [...catalog.format],
    source: `catalog:${catalog.id}`,
  };
}
