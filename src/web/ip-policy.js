// Address policy for host-side outbound requests. Node validates syntax; comparisons use
// numeric addresses so URL canonicalization and IPv4-mapped IPv6 cannot change the decision.
// Special-purpose registries: https://www.iana.org/assignments/iana-ipv4-special-registry/
// and https://www.iana.org/assignments/iana-ipv6-special-registry/ (reviewed 2026-09-07).
import { isIP } from "node:net";

function numericAddress(raw) {
  const family = isIP(raw);
  if (!family || raw.includes("%")) return null;
  if (family === 4) return { bits: 32, value: raw.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n) };
  // Convert a possible dotted tail before expanding the compressed zero groups.
  const hex = raw.replace(/\d+\.\d+\.\d+\.\d+$/, (tail) => {
    const value = numericAddress(tail).value;
    return `${(value >> 16n).toString(16)}:${(value & 65535n).toString(16)}`;
  });
  const [left, right] = hex.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const value = groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
  if (value >> 32n === 65535n) return { bits: 32, value: value & 0xffffffffn };
  return { bits: 128, value };
}

const rules = [
  ["127.0.0.0", 8, "loopback"], ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"], ["172.16.0.0", 12, "private"], ["192.168.0.0", 16, "private"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["100.64.0.0", 10, "carrier-grade NAT / cloud metadata"],
  ["192.0.0.0", 24, "special-purpose"], ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "deprecated relay"], ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"], ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
  ["::1", 128, "loopback"], ["::", 96, "unspecified / IPv4-compatible"],
  ["fc00::", 7, "private"], ["fe80::", 10, "link-local / cloud metadata"],
  ["fec0::", 10, "site-local"], ["ff00::", 8, "multicast"],
  ["64:ff9b::", 96, "NAT64"], ["64:ff9b:1::", 48, "NAT64"],
  ["2001::", 23, "special-purpose"], ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4 relay"], ["3fff::", 20, "documentation"],
].map(([address, prefix, label]) => ({ ...numericAddress(address), prefix, label }));

export function classifyAddress(ip) {
  const address = numericAddress(String(ip || "").trim().toLowerCase());
  if (!address) return "invalid";
  for (const rule of rules) {
    if (rule.bits !== address.bits) continue;
    const shift = BigInt(address.bits - rule.prefix);
    if (address.value >> shift === rule.value >> shift) return rule.label;
  }
  // Public IPv6 destinations must be ordinary global unicast (2000::/3).
  // Transition mechanisms and special-purpose protocol ranges are deliberately excluded.
  if (address.bits === 128 && address.value >> 125n !== 1n) return "reserved";
  return "";
}
