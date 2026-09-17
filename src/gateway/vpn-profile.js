// Deliberately small OpenVPN import format. Never execute an uploaded configuration verbatim:
// reconstruct a client config from allowlisted data, keeping all file paths operator-controlled.
import { isIP } from "node:net";

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 96 * 1024;
const INLINE = new Set(["ca", "cert", "key", "tls-auth", "tls-crypt"]);
const CIPHERS = new Set(["AES-256-GCM", "AES-128-GCM", "AES-256-CBC", "AES-128-CBC", "CHACHA20-POLY1305"]);
function invalid(reason) { throw new Error(`Unsupported VPN profile: ${reason}`); }
function expect(condition, reason) { if (!condition) invalid(reason); }

export function validateVpnTarget(dbHost, dbPort) {
  expect(typeof dbHost === "string" && isIP(dbHost) === 4, "database must be an IPv4 address");
  const first = Number(dbHost.split(".")[0]);
  expect(first > 0 && first < 224 && first !== 127, "database address must be unicast and non-loopback");
  expect((typeof dbPort === "number" && Number.isInteger(dbPort)) || (typeof dbPort === "string" && /^[1-9]\d{0,4}$/.test(dbPort)), "invalid database port");
  const port = Number(dbPort);
  expect(port > 0 && port <= 65535, "invalid database port");
  return { dbHost, dbPort: port };
}

// OpenVPN accepts quoted arguments. Do not copy raw quoted strings into generated directives.
function tokenize(line) {
  const words = [];
  let word = "", quote = null, started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      const next = line[++i];
      expect(next === "\\" || next === '"' || next === "'", "unsupported escape");
      word += next; started = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c; started = true;
    } else if (/\s/.test(c)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else if ((c === "#" || c === ";") && !started) {
      break;
    } else { word += c; started = true; }
  }
  expect(!quote, "unclosed quote");
  if (started) words.push(word);
  return words;
}
function quoted(value) { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function hostValid(host) {
  if (isIP(host) === 4) return true;
  return host.length <= 253 && !/^[\d.]+$/.test(host) && host.split(".").every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part));
}
function validateBlock(kind, body) {
  expect(Buffer.byteLength(body) <= MAX_BLOCK_BYTES, "inline block too large");
  if (kind === "tls-auth" || kind === "tls-crypt") {
    const data = body.split("\n").filter((line) => !line.trim().startsWith("#") && line.trim()).join("\n");
    expect(/^-----BEGIN OpenVPN Static key V1-----\n(?:[a-fA-F0-9]{32}\n){16}-----END OpenVPN Static key V1-----$/.test(data), "invalid inline TLS key");
    return data;
  }
  const labels = kind === "key" ? ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"] : ["CERTIFICATE"];
  let remainder = body.trim(), count = 0;
  while (remainder) {
    const match = /^-----BEGIN ([A-Z ]+)-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----(?:\n|$)/.exec(remainder);
    expect(match && labels.includes(match[1]) && match[2].split("\n").every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line)), "invalid inline PEM block");
    count++;
    remainder = remainder.slice(match[0].length).trim();
  }
  expect(count > 0 && (kind === "ca" || count === 1), "invalid inline PEM count");
  return body.trim();
}

export function normalizeVpnProfile(text, { dbHost, dbPort } = {}) {
  validateVpnTarget(dbHost, dbPort);
  expect(typeof text === "string" && Buffer.byteLength(text) <= MAX_PROFILE_BYTES, "profile must be bounded text");
  text = text.replace(/\r\n/g, "\n");
  expect(!/[\x00-\x08\x0b-\x1f\x7f\u0080-\uffff]/.test(text), "invalid control or non-ASCII character");
  const lines = text.split("\n"), values = new Map(), blocks = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const inline = /^<([a-z-]+)>$/.exec(line);
    if (inline) {
      const kind = inline[1];
      expect(INLINE.has(kind) && !blocks.has(kind), "unknown or duplicate inline block");
      const body = [];
      while (++i < lines.length && lines[i].trim() !== `</${kind}>`) body.push(lines[i]);
      expect(i < lines.length, "unclosed inline block");
      blocks.set(kind, validateBlock(kind, body.join("\n")));
      continue;
    }
    const [name, ...args] = tokenize(line);
    if (!name) continue;
    expect(!values.has(name), "duplicate directive");
    const single = (pattern) => args.length === 1 && pattern.test(args[0]);
    let valid = false;
    switch (name) {
      case "client": case "nobind": case "persist-key": case "persist-tun": case "auth-user-pass":
      case "auth-nocache": case "route-nopull": valid = args.length === 0; break;
      case "dev": valid = single(/^tun$/); break;
      case "proto": valid = single(/^(tcp|tcp-client)$/); break;
      case "remote": valid = args.length >= 2 && args.length <= 3 && hostValid(args[0]) && /^[1-9]\d{0,4}$/.test(args[1]) && Number(args[1]) <= 65535 && (args.length === 2 || /^(tcp|tcp-client)$/.test(args[2])); break;
      case "remote-cert-tls": valid = single(/^server$/); break;
      case "verify-x509-name": valid = args.length >= 1 && args.length <= 2 && args[0].length > 0 && args[0].length <= 1024 && (args.length === 1 || /^(subject|name|name-prefix)$/.test(args[1])); break;
      case "cipher": case "data-ciphers-fallback": valid = args.length === 1 && CIPHERS.has(args[0]); break;
      case "data-ciphers": valid = args.length === 1 && args[0].split(":").every((cipher) => CIPHERS.has(cipher)); break;
      case "auth": valid = single(/^SHA(256|384|512)$/); break;
      case "resolv-retry": valid = single(/^(infinite|[1-9]\d{0,3})$/); break;
      case "route-delay": valid = single(/^([0-9]|[1-5][0-9]|60)$/); break;
      case "reneg-sec": valid = single(/^(0|[1-9]\d{0,6})$/); break;
      case "verb": valid = single(/^[0-6]$/); break;
      case "key-direction": valid = single(/^[01]$/); break;
      case "route": valid = args.join(" ") === "remote_host 255.255.255.255 net_gateway"; break;
      default: invalid("directive is not allowed");
    }
    expect(valid, "invalid directive arguments");
    values.set(name, args);
  }
  for (const name of ["client", "dev", "proto", "remote"]) expect(values.has(name), "missing required client directive");
  for (const name of ["ca", "cert", "key"]) expect(blocks.has(name), "missing inline client identity");
  expect(!(blocks.has("tls-auth") && blocks.has("tls-crypt")), "conflicting TLS key modes");
  expect(!values.has("key-direction") || blocks.has("tls-auth"), "key-direction requires tls-auth");
  const [host, port] = values.get("remote");
  const output = ["client", "dev tun0", "proto tcp-client", `remote ${host} ${port}`, "nobind", "persist-key", "persist-tun",
    "auth-user-pass /vpn/auth", "auth-nocache", "route-nopull", "script-security 1", "remote-cert-tls server", "verb 3",
    "route remote_host 255.255.255.255 net_gateway", `route ${dbHost} 255.255.255.255 vpn_gateway`];
  for (const name of ["verify-x509-name", "auth", "resolv-retry", "route-delay", "reneg-sec", "key-direction"]) {
    if (values.has(name)) output.push(`${name} ${values.get(name).map(quoted).join(" ")}`);
  }
  const cipher = values.get("cipher")?.[0];
  if (cipher) output.push(`cipher ${cipher}`);
  const dataCiphers = values.get("data-ciphers")?.[0] || (cipher?.endsWith("-CBC") ? `AES-256-GCM:AES-128-GCM:${cipher}` : "AES-256-GCM:AES-128-GCM");
  output.push(`data-ciphers ${dataCiphers}`);
  const fallback = values.get("data-ciphers-fallback")?.[0] || (cipher?.endsWith("-CBC") ? cipher : null);
  if (fallback) output.push(`data-ciphers-fallback ${fallback}`);
  for (const [kind, body] of blocks) output.push(`<${kind}>\n${body}\n</${kind}>`);
  return { config: `${output.join("\n")}\n`, remote: { host, port: Number(port), proto: "tcp-client" }, hasClientKey: true };
}
