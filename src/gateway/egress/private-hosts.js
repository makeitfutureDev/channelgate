// Admin-approved PRIVATE destinations (`meta.egressPrivateHosts`): one exact host:port per entry,
// pinned to the address it resolved to when an admin approved it. The proxy carries a matching
// CONNECT as a raw byte tunnel (SSH, FTP, a database, a local MCP over http/https) or forwards a
// plain absolute-form http request — always to the PINNED address, and only while every current
// DNS answer still equals it (no rebinding onto another internal host).
//
// Stored form, one string per entry: `<host>:<port>@<address>` (IPv6 hosts bracketed), e.g.
// `nas.lan:22@192.168.1.10`, `[fd00::5]:21@fd00::5`, `host.channelgate.internal:8931@127.0.0.1`.
//
// Inside a container 127.0.0.1 is the container itself and NO_PROXY keeps it off the proxy, so a
// service on the gateway HOST's loopback is reached through the reserved alias
// `host.channelgate.internal`, which the proxy maps to the pinned loopback address and nothing else.
//
// Never approvable, whatever an admin clicks: link-local and cloud-metadata addresses, the
// unspecified/multicast/reserved/documentation ranges, and the gateway's own admin UI port on loopback.
import { isIP } from "node:net";
import { classifyAddress } from "../../web/ip-policy.js";
import { normalizeHost } from "./rules.js";

export const LOOPBACK_ALIAS = "host.channelgate.internal";
export const MAX_PRIVATE_HOSTS = 16;

// Address classes an admin may approve. "" is public (allowed: a pinned public address is harmless).
const APPROVABLE = new Set(["", "loopback", "private", "carrier-grade NAT / cloud metadata"]);
// Single cloud-metadata addresses inside otherwise approvable ranges (Alibaba Cloud in 100.64/10).
const METADATA_ADDRESSES = new Set(["100.100.100.200"]);

function canonicalAddress(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(raw) && !raw.includes("%") ? raw : "";
}

export function gatewayOwnPorts() {
  const port = Number(process.env.PORT ?? 4747);
  return Number.isInteger(port) && port > 0 ? [port] : [];
}

// "" when an admin may approve `address:port`, else the reason it never can be.
export function privateAddressProblem(address, port, { ownPorts = gatewayOwnPorts() } = {}) {
  const addr = canonicalAddress(address);
  if (!addr) return "is not a valid IP address";
  const kind = classifyAddress(addr);
  if (!APPROVABLE.has(kind) || METADATA_ADDRESSES.has(addr)) return `is ${kind === "invalid" ? "an invalid" : `a ${kind}`} address, which channels may never reach`;
  if (kind === "loopback" && ownPorts.includes(Number(port))) return "is the gateway's own admin port, which channels may never reach";
  return "";
}

const isLoopbackName = (host) => host === "localhost" || host === LOOPBACK_ALIAS;

// The host name a container uses for an approved destination: loopback goes through the alias.
export function containerHostFor(host, address) {
  const addr = canonicalAddress(address);
  return addr && classifyAddress(addr) === "loopback" ? LOOPBACK_ALIAS : host;
}

function authority(host, port) {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export function formatPrivateHost({ host, port, address }) {
  return `${authority(host, port)}@${canonicalAddress(address)}`;
}

// → { host, port, address, value } or null.
export function parsePrivateHost(value, options) {
  const match = /^(\[[^\]]+\]|[^:@\s]+):(\d{1,5})@(\S+)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const host = normalizeHost(match[1].replace(/^\[|\]$/g, ""));
  const port = Number(match[2]);
  const address = canonicalAddress(match[3]);
  if (!host || host.includes("*") || !Number.isInteger(port) || port < 1 || port > 65535 || !address) return null;
  if (isIP(host) && canonicalAddress(host) !== address) return null;
  if (isLoopbackName(host) && (host !== LOOPBACK_ALIAS || classifyAddress(address) !== "loopback")) return null;
  if (classifyAddress(address) === "loopback" && host !== LOOPBACK_ALIAS) return null;
  if (privateAddressProblem(address, port, options)) return null;
  return { host, port, address, value: formatPrivateHost({ host, port, address }) };
}

// Strict (write side).
export function assertValidEgressPrivateHosts(value, options) {
  const inputs = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const parsed = inputs.map((entry) => parsePrivateHost(entry, options));
  const bad = parsed.findIndex((entry) => entry === null);
  if (bad !== -1) throw new Error(`"${inputs[bad]}" is not an approvable private destination (host:port@address).`);
  const byAuthority = new Map();
  for (const entry of parsed) byAuthority.set(authority(entry.host, entry.port), entry.value);
  const list = [...byAuthority.values()];
  if (list.length > MAX_PRIVATE_HOSTS) throw new Error(`At most ${MAX_PRIVATE_HOSTS} private destinations per channel.`);
  return list;
}

// Tolerant (read side): what the proxy policy receives.
export function privateDestinationsFor(meta = {}) {
  const list = Array.isArray(meta?.egressPrivateHosts) ? meta.egressPrivateHosts : [];
  return list.map((entry) => parsePrivateHost(entry)).filter(Boolean).map(({ host, port, address }) => ({ host, port, address }));
}
