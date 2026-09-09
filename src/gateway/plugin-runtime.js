// Approved packages reuse skill revisions and grants. Engine-specific components are compiled
// explicitly; package MCP settings never enter ambient engine discovery or replace identities.
import path from "node:path";
import { createHash } from "node:crypto";
import { parsePluginPackage } from "./skills/plugin-package.js";
import { skillBundle } from "./skills/catalog.js";
import { resolveSkillProfile } from "./skills/resolve.js";
import { parseFrontmatter, skillMetadata } from "./skills/frontmatter.js";

export function grantedPluginPackages(names, { profileFor = resolveSkillProfile, bundleFor = skillBundle } = {}) {
  return profileFor(names).active.flatMap(({ skill }) => {
    const bundle = bundleFor(skill);
    const descriptor = bundle && parsePluginPackage(bundle.files);
    return descriptor ? [{ slug: skill.slug, revision: bundle.revision, descriptor }] : [];
  });
}

export function pluginServerName(slug, name) {
  const digest = createHash("sha256").update(JSON.stringify([slug, name])).digest("hex").slice(0, 12);
  return `cg_plugin_${slug.replace(/[^a-z0-9_]/gi, "_").slice(0, 48)}_${digest}`;
}

function readJson(descriptor, file) {
  const entry = descriptor.files.find((f) => f.path === file);
  if (!entry) throw new Error(`Plugin ${descriptor.name} is missing ${file}`);
  try { return JSON.parse(entry.content.toString("utf8")); }
  catch { throw new Error(`Plugin ${descriptor.name} has invalid JSON in ${file}`); }
}

function componentConfigs(descriptor, key, manifestEngine) {
  const out = [];
  for (const file of descriptor.components[key] || []) {
    const owner = Object.entries(descriptor.manifests).find(([engine]) => file === `.${engine}-plugin/plugin.json`);
    if (owner) {
      if (owner[0] === manifestEngine) out.push(owner[1][key]);
    } else out.push(readJson(descriptor, file));
  }
  return out;
}

// Plugin sources are reviewed code, not credential stores. Reconstruct only explicit transports;
// every unsupported field or authentication dependency requires a separately selected connection.
function publicPluginMcpDefinition(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const allowed = new Set(["type", "transport", "url", "command", "args"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) return null;
  if (source.url != null) {
    if (typeof source.url !== "string" || source.command != null || source.args != null
      || (source.type != null && !["http", "streamable-http"].includes(source.type))
      || (source.transport != null && !["http", "streamable-http"].includes(source.transport))) return null;
    let url;
    try { url = new URL(source.url); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /[\s$]/.test(source.url)) return null;
    return { transport: "http", url: source.url };
  }
  if (typeof source.command !== "string" || !source.command.trim()
    || (source.type != null && source.type !== "stdio")
    || (source.transport != null && source.transport !== "stdio")
    || (source.args != null && (!Array.isArray(source.args) || source.args.some((arg) => typeof arg !== "string")))) return null;
  const args = source.args || [];
  // Literal command bodies are reviewed source code. Known authentication flags and unresolved
  // environment substitutions are instead connection configuration and must not reach argv.
  const values = [source.command, ...args];
  if (values.some((value) => /[\0\r\n]/.test(value)
    || /(?:^|[\s=])--?(?:[a-z]+-)*(?:token|password|passwd|secret|api-?key|auth|authorization|credential)(?:[s-]|=|$)/i.test(value)
    || /\$(?:[A-Za-z_]|\{)/.test(value.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, "")))) return null;
  return { transport: "stdio", command: source.command, args };
}

// `capabilities` is an engine adapter fact, not an engine-name branch in the orchestrator.
export function compilePluginPackage(pkg, { capabilities, allowBypass = false, writable = false } = {}) {
  const { descriptor: d, slug } = pkg;
  if (["gateway-shared-skills", "gateway-user-grants"].includes(d.name.toLowerCase())) throw new Error(`Plugin ${slug}: the plugin name is reserved by the gateway`);
  if (!capabilities) throw new Error(`Plugin ${slug}: this engine does not support plugin packages`);
  for (const key of ["agents", "commands", "hooks", "apps", "lspServers"]) {
    if (d.components[key]?.length && !capabilities.components.includes(key)) {
      throw new Error(`Plugin ${slug}: ${key} are unsupported by this engine; select a compatible engine or remove this plugin grant`);
    }
  }
  if (d.components.hooks.length && !allowBypass) throw new Error(`Plugin ${slug}: hooks require an authorized live admin turn in a Full-access conversation`);
  const manifestEngine = d.manifests[capabilities.manifest] ? capabilities.manifest : d.engines[0];
  const manifest = d.manifests[manifestEngine];
  // Only known component paths are forwarded. In particular settings, MCP, apps, and LSP
  // declarations cannot silently expand permissions or activate an unselected service.
  const native = { name: d.name, version: d.version || "1.0.0", description: d.description };
  for (const key of ["skills", "agents", "commands"]) {
    if (!d.components[key].length) continue;
    const paths = key === "agents"
      ? d.files.filter((f) => /\.md$/i.test(f.path) && d.components.agents.some((p) => f.path === p || f.path.startsWith(`${p}/`))).map((f) => f.path)
      : d.components[key];
    native[key] = paths.map((p) => `./${p}`);
  }
  const hooks = componentConfigs(d, "hooks", manifestEngine);
  if (hooks.length) {
    const merged = {};
    for (const config of hooks) {
      const events = config?.hooks || config;
      if (!events || typeof events !== "object" || Array.isArray(events)) throw new Error(`Plugin ${slug}: invalid hooks configuration`);
      for (const [event, entries] of Object.entries(events)) {
        if (!Array.isArray(entries)) throw new Error(`Plugin ${slug}: invalid hook event ${event}`);
        merged[event] = [...(merged[event] || []), ...entries];
      }
    }
    native.hooks = { hooks: merged };
  }
  const servers = [];
  const seen = new Set();
  for (const config of componentConfigs(d, "mcpServers", manifestEngine)) {
    const entries = config?.mcpServers || config;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`Plugin ${slug}: invalid MCP configuration`);
    for (const [name, definition] of Object.entries(entries)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(name) || seen.has(name)) throw new Error(`Plugin ${slug}: invalid or duplicate MCP server name`);
      seen.add(name);
      const safe = publicPluginMcpDefinition(definition);
      if (safe?.transport === "stdio" && !writable) throw new Error(`Plugin ${slug}: MCP server commands require a Worker or Full-access conversation`);
      // Unsupported auth/transport must be satisfied by an explicitly selected connection;
      // never copy source credentials into argv, resolve host env, or silently discard them.
      servers.push({ name: pluginServerName(slug, name), sourceName: name, plugin: slug, definition: safe });
    }
  }
  const controlFiles = new Set([".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "hooks.json", ...d.components.mcpServers, ...d.components.hooks]);
  const files = d.files.filter((f) => !controlFiles.has(f.path));
  if (capabilities.manifest) files.push({ path: `.${capabilities.manifest}-plugin/plugin.json`, content: Buffer.from(JSON.stringify(native)), executable: false });
  // Disable implicit hook discovery: hooks are declared once above, after policy checks.
  const skillFiles = d.files.filter((f) => /(?:^|\/)SKILL\.md$/i.test(f.path) && d.components.skills.some((p) => f.path === p || f.path.startsWith(`${p}/`))).map((f) => {
    const md = skillMetadata(parseFrontmatter(f.content.toString("utf8")).data);
    if (!md.name || !md.description) throw new Error(`Plugin ${slug}: ${f.path} needs a skill name and description`);
    return { name: `${d.name}:${md.name}`, description: md.description, path: f.path };
  });
  // Explicitly reject declarative engine settings which cannot be carried without replacing
  // gateway policy. The raw file remains in the reviewed catalog revision.
  if (manifest.settings || d.files.some((f) => ["settings.json", ".claude/settings.json", ".codex/config.toml"].includes(f.path))) throw new Error(`Plugin ${slug}: plugin settings overrides are unsupported`);
  return { files, native: Boolean(capabilities.manifest), skillFiles, servers };
}

// Replace only package-root placeholders. Other environment expansion needs a separately
// configured connection; expansion on the daemon would leak the operator's own credentials.
export function relocatePluginServers(servers, root) {
  return servers.map((server) => {
    if (!server.definition) return server;
    const replace = (s) => {
      const value = s.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, () => root);
      if (/\$\{|\$[A-Za-z_]/.test(value)) throw new Error(`Plugin ${server.plugin}: MCP ${server.sourceName} requires a separately configured connection for environment variables`);
      return value;
    };
    const definition = { ...server.definition };
    if (definition.command) definition.command = replace(definition.command);
    if (definition.args) definition.args = definition.args.map(replace);
    if (definition.url) definition.url = replace(definition.url);
    return { ...server, definition };
  });
}

export function pluginSkillCatalog(compiled, root) {
  return compiled.skillFiles.map((skill) => ({ ...skill, path: path.join(root, skill.path) }));
}

export function requirePluginRuntime(runtime, engine) {
  const selected = runtime?.[engine];
  if (selected?.error) throw new Error(selected.error);
  return selected || { dirs: [], skills: [], servers: [] };
}
