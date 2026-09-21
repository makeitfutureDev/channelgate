// Claude's isolated runners disable user/project setting sources. Optional server grants must
// therefore carry explicit transport definitions; enabling ambient config would also import
// unrelated MCPs, hooks and credentials. Resolve fresh bytes at admission, never a UI cache or a
// shell-split `mcp list` display string. Only transport data leaves this module.
// A selection that fails any of those checks is DROPPED from the payload with a category
// reason, not thrown: refusing to relay the host credential is the security property, and the
// turn itself never depended on an optional connector.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RESERVED = new Set(["gateway", "composio", "composio-user", "composio-agent", "makeitfuture-toolbox", "make-toolbox", "__proto__", "constructor", "prototype"]);
const NAME = /^[a-zA-Z0-9_.-]{1,160}$/;
const OBJECT = (value) => value && typeof value === "object" && !Array.isArray(value);
const own = (object, name) => OBJECT(object) && Object.hasOwn(object, name) ? object[name] : undefined;

export function safeClaudeMcpDefinition(source) {
  if (!OBJECT(source)) return null;
  // Reject unknown options rather than silently dropping OAuth/header helpers or future auth
  // dependencies. Empty legacy env/headers maps are harmless; populated maps never cross over.
  if (Object.keys(source).some((key) => !["type", "command", "args", "url", "env", "headers"].includes(key))) return null;
  for (const key of ["env", "headers"]) {
    if (source[key] !== undefined && (!OBJECT(source[key]) || Object.keys(source[key]).length)) return null;
  }
  const type = source.type || (source.url ? "http" : "stdio");
  if (type === "http" || type === "sse") {
    if (source.command !== undefined || source.args !== undefined || typeof source.url !== "string") return null;
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\$\{/.test(source.url)) return null;
    } catch { return null; }
    return { type, url: source.url };
  }
  if (type !== "stdio" || source.url !== undefined || typeof source.command !== "string" || !source.command.trim()) return null;
  if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some((arg) => typeof arg !== "string"))) return null;
  const args = source.args || [];
  // Do not expand daemon environment values or relay literal credential-bearing command flags.
  if ([source.command, ...args].some((value) => /\$\{|(?:^|\s)--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret|authorization|bearer)(?:[=\s]|$)/i.test(value))) return null;
  return { type: "stdio", command: source.command, args: [...args] };
}

async function readConfig(file) {
  try {
    const bytes = await readFile(file, "utf8");
    if (bytes.length > 8 * 1024 * 1024) throw new Error("oversized");
    const data = JSON.parse(bytes);
    if (!OBJECT(data)) throw new Error("invalid");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    // Never include raw parser errors, file contents, or private config paths in a chat error.
    throw new Error("unreadable");
  }
}

// Why a selection was not admitted. Category only — never a path, a parser error, a config value
// or the offending definition, because this text is posted into the channel.
const REJECTION = {
  unreadable: "could not be read from the gateway host's Claude MCP configuration",
  missing: "is not defined in the gateway host's Claude MCP configuration",
  unsafe: "needs host credentials (env/headers/auth helper) or uses an unsupported transport",
  stale: "no longer matches the transport it was selected with",
  namespace: "does not match its own tool namespace",
  name: "uses a reserved or invalid server name",
};

function namespaceOf(name) {
  return "mcp__" + name.replace(/[^a-zA-Z0-9]+/g, "_");
}

// Returns { servers, rejected }. An optional connector that cannot be admitted is DROPPED with a
// reason, never fatal: refusing to relay a host credential into the container is the security
// property, and dropping the server keeps it whole — failing the whole turn only adds downtime for
// a conversation that may not even use the connector. The caller reports `rejected` in the thread
// so a dropped server is loud without being terminal.
export async function resolveClaudeMcpConfig(allowedMcps = [], {
  configFile = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(os.homedir(), ".claude.json"),
  discoveryCwd = process.cwd(),
} = {}) {
  const servers = {};
  const rejected = [];
  if (!Array.isArray(allowedMcps) || !allowedMcps.length) return { servers, rejected };
  const selected = [];
  for (const entry of allowedMcps) {
    const name = entry?.name;
    // A reserved or malformed name cannot come from the picker (sanitizeMcps +
    // persistedSelectionForEngine), so it means the stored record was hand-edited or tampered
    // with. It is still only dropped — never injected, so it can never shadow a built-in identity
    // — and the caller's event/notice is what makes it visible.
    if (typeof name !== "string" || !NAME.test(name) || RESERVED.has(name) || /composio/i.test(name)) {
      rejected.push({ name: typeof name === "string" ? name.slice(0, 160) : "(unnamed)", reason: REJECTION.name });
      continue;
    }
    selected.push(entry);
  }
  if (!selected.length) return { servers, rejected };
  // These are the same scopes `claude mcp list` in the daemon cwd discovers. Local project
  // overrides beat project .mcp.json, which beats user scope. The channel workdir is never a
  // config source: its members cannot replace an operator-selected definition with their own.
  let user;
  let project;
  try {
    user = await readConfig(configFile);
    project = await readConfig(path.join(discoveryCwd, ".mcp.json"));
  } catch {
    // A corrupt or unreadable operator config must not brick every channel that selected anything.
    for (const entry of selected) rejected.push({ name: entry.name, reason: REJECTION.unreadable });
    return { servers, rejected };
  }
  const localServers = own(own(own(user, "projects"), path.resolve(discoveryCwd)), "mcpServers");
  for (const entry of selected) {
    const scope = [localServers, own(project, "mcpServers"), own(user, "mcpServers")].find((servers) => OBJECT(servers) && Object.hasOwn(servers, entry.name));
    const source = own(scope, entry.name);
    const definition = safeClaudeMcpDefinition(source);
    const expectedMatch = definition?.type === "stdio" ? entry.match?.serverName === entry.name : entry.match?.serverUrl === definition?.url;
    const reason = source === undefined ? REJECTION.missing
      : !definition ? REJECTION.unsafe
      : !expectedMatch ? REJECTION.stale
      : entry.namespace !== namespaceOf(entry.name) ? REJECTION.namespace
      : "";
    if (reason) {
      rejected.push({ name: entry.name, reason });
      continue;
    }
    servers[entry.name] = definition;
  }
  return { servers, rejected };
}
