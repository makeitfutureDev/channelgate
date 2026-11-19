// Admin-approved PRIVATE destinations for custom MCP connections (src/gateway/custom-mcps.js).
//
// Why: a custom MCP is dialled by the DAEMON (src/mcp/remote-relay.js), which sits outside every
// channel's egress proxy, so by default it reaches public addresses only — a person-supplied URL
// must never become a way into the host's loopback services, the LAN or cloud metadata. Some
// deployments run their MCP servers on the LAN beside the gateway (a CAD workstation's plugin, an
// internal tool) with no public URL at all. This list is the operator's explicit, narrow exception:
// each entry is ONE exact `host:port` an organization admin approved in Settings, and only an
// address in the RFC 1918 / IPv6 unique-local ("private") class may ever be reached through it —
// never loopback, link-local/cloud metadata, CGNAT or any other special range, whatever an entry
// says. A matching custom MCP may use plain http:// (LAN servers rarely carry TLS).
//
// Pure: no settings, no DNS. The setting getter lives in src/config/settings.js and the per-dial
// resolution in src/mcp/public-fetch.js.
import { isIP } from "node:net";
import { classifyAddress } from "../web/ip-policy.js";

export const PRIVATE_MCP_HOST_LIMIT = 32;
// The ONLY address class an approved entry may reach (src/web/ip-policy.js labels).
export const PRIVATE_MCP_ADDRESS_CLASS = "private";
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function validDnsName(host) {
  if (host.length > 253) return false;
  const labels = host.split(".");
  return labels.every((label) => DNS_LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]);
}

/**
 * The canonical `host:port` (`[v6]:port` for IPv6), or a throw naming the rule. The port is
 * required — an approval opens exactly one service, never a whole machine. An IP literal must be in
 * the private class; a DNS name is accepted here and must RESOLVE to private addresses at every dial.
 */
export function normalizePrivateMcpHost(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/.exec(raw) || /^([a-z0-9.-]+):(\d{1,5})$/.exec(raw);
  if (!match) throw new Error(`"${raw}" must be host:port, e.g. 192.168.1.20:10500 or [fd00::5]:8080`);
  const [, host, portText] = match;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${raw}": port must be 1-65535`);
  const family = isIP(host);
  if (family) {
    const kind = classifyAddress(host);
    if (kind !== PRIVATE_MCP_ADDRESS_CLASS) {
      throw new Error(`"${raw}": only private LAN addresses (10/8, 172.16/12, 192.168/16, fc00::/7) may be approved, not a ${kind || "public"} address`);
    }
  } else if (!validDnsName(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`"${raw}": not a valid host name`);
  }
  // URL's own canonical form, so the entry compares equal to privateMcpHostKey() of a dialled URL.
  return family === 6 ? `${new URL(`http://[${host}]/`).hostname}:${port}` : `${host}:${port}`;
}

/** A whole list, refusing on the first bad entry (a save must not silently drop one). */
export function normalizePrivateMcpHosts(list) {
  if (!Array.isArray(list)) throw new Error("privateMcpHosts must be an array of host:port entries");
  const out = [];
  for (const entry of list) {
    if (String(entry ?? "").trim() === "") continue;
    const normalized = normalizePrivateMcpHost(entry);
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length > PRIVATE_MCP_HOST_LIMIT) throw new Error(`At most ${PRIVATE_MCP_HOST_LIMIT} private MCP destinations`);
  return out;
}

/** The stored list read leniently: invalid entries are dropped, never trusted. */
export function readPrivateMcpHosts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    try {
      const normalized = normalizePrivateMcpHost(entry);
      if (!out.includes(normalized)) out.push(normalized);
    } catch { /* dropped */ }
  }
  return out.slice(0, PRIVATE_MCP_HOST_LIMIT);
}

/** The `host:port` key of a parsed http(s) URL, with the scheme's default port filled in. */
export function privateMcpHostKey(url) {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}
