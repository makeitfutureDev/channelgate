// Claude's isolated runners disable user/project setting sources. Optional server grants must
// therefore carry explicit transport definitions; enabling ambient config would also import
// unrelated MCPs, hooks and credentials. Resolve fresh bytes at admission, never a UI cache or a
// shell-split `mcp list` display string. Only transport data leaves this module.
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
    throw new Error("Selected Claude MCP configuration could not be read safely. Ask an admin to check the configured server.");
  }
}

export async function resolveClaudeMcpConfig(allowedMcps = [], {
  configFile = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(os.homedir(), ".claude.json"),
  discoveryCwd = process.cwd(),
} = {}) {
  if (!Array.isArray(allowedMcps) || !allowedMcps.length) return {};
  const selected = allowedMcps.map((entry) => {
    const name = entry?.name;
    if (typeof name !== "string" || !NAME.test(name) || RESERVED.has(name) || /composio/i.test(name)) {
      throw new Error("Selected Claude MCP server name is invalid or reserved.");
    }
    return entry;
  });
  // These are the same scopes `claude mcp list` in the daemon cwd discovers. Local project
  // overrides beat project .mcp.json, which beats user scope. The channel workdir is never a
  // config source: its members cannot replace an operator-selected definition with their own.
  const user = await readConfig(configFile);
  const project = await readConfig(path.join(discoveryCwd, ".mcp.json"));
  const localServers = own(own(own(user, "projects"), path.resolve(discoveryCwd)), "mcpServers");
  const servers = {};
  for (const entry of selected) {
    const scope = [localServers, own(project, "mcpServers"), own(user, "mcpServers")].find((servers) => OBJECT(servers) && Object.hasOwn(servers, entry.name));
    const source = own(scope, entry.name);
    const definition = safeClaudeMcpDefinition(source);
    const expectedMatch = definition?.type === "stdio" ? entry.match?.serverName === entry.name : entry.match?.serverUrl === definition?.url;
    if (!definition || !expectedMatch || entry.namespace !== "mcp__" + entry.name.replace(/[^a-zA-Z0-9]+/g, "_")) {
      throw new Error(`Selected Claude MCP server "${entry.name}" has no safe matching transport definition. Ask an admin to configure a credential-free server reachable inside the channel container and select it again.`);
    }
    servers[entry.name] = definition;
  }
  return servers;
}
