// Destination policy for the egress proxy: may this channel reach host:port, and at which address?
//
// Why: once containers run with `--network none`, the proxy IS the network, so it is also the SSRF
// boundary. A container must not reach the daemon's loopback services, the LAN, or the cloud
// metadata endpoint just because a hostname resolves there. The check resolves ALL addresses and
// refuses when ANY of them is non-public (so a name that mixes a public and a private answer cannot
// be raced), then returns the first address PINNED for the connect — the proxy dials that literal,
// never the name again, which is what makes DNS rebinding useless.
//
// Address classes come from src/web/ip-policy.js (the admin UI's SSRF guard): loopback, private,
// link-local incl. 169.254.169.254, CGNAT, unspecified, multicast, documentation/reserved ranges,
// and IPv4-mapped IPv6 forms of all of them (it compares numeric addresses).
//
// Modes (the per-channel Allow network switch): "off" → only `engineHosts` (the engine endpoints
// and relays a turn needs); "on" → any public destination, or only `allowHosts` (plus engine hosts)
// when an allowlist is given. `rawPassthrough` ({host, port} entries) marks destinations that get a
// plain CONNECT tunnel WITHOUT TLS termination (SSH, Postgres); honored only when mode is "on".
// Unknown modes fail closed.
import dns from "node:dns";
import { isIP } from "node:net";
import { classifyAddress } from "../../web/ip-policy.js";
import { hostMatches, normalizeHost } from "./rules.js";

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// A syntactically valid DNS name (no wildcard, ≤ 253 chars, labels 1–63 of [a-z0-9-]) or IP literal.
export function isValidDestinationHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (isIP(h)) return !h.includes("%");
  if (h.length > 253) return false;
  const labels = h.split(".");
  return labels.every((label) => DNS_LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]);
}

function refuse(category, reason) {
  return { ok: false, category, reason, address: null, tunnel: false };
}

function matchesAny(patterns, hostname) {
  return Array.isArray(patterns) && patterns.some((pattern) => hostMatches(pattern, hostname));
}

function defaultLookup(hostname, options) {
  return dns.promises.lookup(hostname, options);
}

export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

// A lookup runs on libuv's small shared thread pool; one that never answers must not hold a CONNECT
// (or a pool thread's worth of other channels' work) forever. Racing it against a deadline frees
// the request; the stuck lookup itself finishes or fails in the background.
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("DNS lookup timed out"), { code: "CG_DNS_TIMEOUT" })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function resolveAll(hostname, lookup, timeoutMs = DNS_LOOKUP_TIMEOUT_MS) {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  const fn = lookup || defaultLookup;
  // Support both a promise-returning lookup and the callback style of dns.lookup.
  const pending = fn.length >= 3
    ? new Promise((resolve, reject) => fn(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))))
    : Promise.resolve().then(() => fn(hostname, { all: true, verbatim: true }));
  pending.catch(() => {}); // a lookup that loses the race may still reject later
  const result = await withDeadline(pending, timeoutMs);
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.map((entry) => (typeof entry === "string" ? { address: entry, family: isIP(entry) } : entry));
}

// → { ok, category?, reason?, address, family?, tunnel }.
// `allowLoopbackHosts` is TEST-ONLY: names listed there may resolve to loopback (the end-to-end
// suite points a fake hostname at a 127.0.0.1 upstream). Production callers never pass it.
export async function checkDestination({ hostname, port, mode, allowHosts = null, rawPassthrough = [], engineHosts = [], lookup, allowLoopbackHosts = [], lookupTimeoutMs = DNS_LOOKUP_TIMEOUT_MS }) {
  const host = normalizeHost(hostname);
  const portNumber = Number(port);
  if (!isValidDestinationHost(host) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return refuse("invalid-destination", "The destination is not a valid host name and port.");
  }
  const engine = matchesAny(engineHosts, host);
  let tunnel = false;
  if (mode === "off") {
    if (!engine) return refuse("network-off", `Network access is off for this channel; ${host} is not an engine endpoint.`);
  } else if (mode === "on") {
    tunnel = Array.isArray(rawPassthrough) && rawPassthrough.some((rule) => hostMatches(rule?.host, host) && Number(rule?.port) === portNumber);
    if (allowHosts !== null && allowHosts !== undefined && !engine && !tunnel && !matchesAny(allowHosts, host)) {
      return refuse("not-allowlisted", `${host} is not on this channel's allowed hosts.`);
    }
  } else {
    return refuse("policy", "No network policy is configured for this channel.");
  }

  let addresses;
  try {
    addresses = await resolveAll(host, lookup, lookupTimeoutMs);
  } catch (error) {
    if (error?.code === "CG_DNS_TIMEOUT") return refuse("dns-timeout", `${host} did not resolve in time.`);
    return refuse("dns-failure", `${host} could not be resolved.`);
  }
  if (!addresses.length) return refuse("dns-failure", `${host} could not be resolved.`);
  const loopbackOk = matchesAny(allowLoopbackHosts, host);
  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind === "" || (kind === "loopback" && loopbackOk)) continue;
    const label = kind === "invalid" ? "an invalid address" : `a ${kind} address`;
    return refuse("blocked-address", `${host} resolves to ${label}, which channels may not reach.`);
  }
  const first = addresses[0];
  return { ok: true, address: first.address, family: first.family || isIP(first.address), tunnel };
}
