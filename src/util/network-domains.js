import { isIP } from "node:net";

// One strict representation feeds every engine. Keep this narrower than either CLI accepts so a
// saved value can never mean one thing to Claude and a broader thing to Codex. Public DNS names
// plus scoped subdomain wildcards are supported; global wildcards, URLs, ports, IP literals, and
// local/single-label hosts are deliberately refused.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeNetworkDomain(value) {
  let domain = String(value ?? "").trim().toLowerCase();
  if (!domain) throw new Error("network domain must not be empty");
  if (/\s|:\/\/|[\/@:#?\[\]]/.test(domain)) {
    throw new Error(`invalid network domain "${domain}"; use a bare hostname without a URL, port, or path`);
  }
  domain = domain.replace(/\.$/, "");
  const wildcard = domain.startsWith("*.") ? "*." : "";
  const hostname = wildcard ? domain.slice(wildcard.length) : domain;
  if (domain === "*" || hostname === "localhost" || isIP(hostname)) {
    throw new Error(`unsafe network domain "${domain}" is not allowed`);
  }
  if (hostname.length > 253 || !hostname.includes(".") || hostname.split(".").some((label) => !LABEL.test(label))) {
    throw new Error(`invalid network domain "${domain}"`);
  }
  return `${wildcard}${hostname}`;
}

// Accept what a human (or an agent quoting an error) actually pastes — a bare domain OR a full
// URL — and reduce it to the strict bare-hostname form above. Never widens: the extracted
// hostname still has to pass normalizeNetworkDomain.
export function normalizeRequestedDomain(input) {
  let value = String(input ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw new Error(`invalid URL "${input}"`);
    }
  } else {
    // Bare "host/path" or "host:port" forms: keep only the host part.
    value = value.split(/[/?#]/)[0].split("@").pop().split(":")[0];
  }
  return normalizeNetworkDomain(value);
}

// Stored per-channel extras are read on EVERY spawn: a malformed hand edit must degrade to "no
// extras", never break run startup or acquire engine-specific meaning.
export function normalizeStoredDomains(values) {
  try {
    return normalizeNetworkDomains(Array.isArray(values) ? values : [], { allowEmpty: true });
  } catch {
    return [];
  }
}

export function normalizeNetworkDomains(values, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) throw new Error("network domains must be an array");
  const raw = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!raw.length) {
    if (allowEmpty) return [];
    throw new Error("at least one approved network domain is required");
  }
  return [...new Set(raw.map(normalizeNetworkDomain))];
}
