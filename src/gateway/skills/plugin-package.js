// Plugins use the existing revision, approval and grant model. Their original tree is stored
// below package/ and a derived SKILL.md makes the package one selectable catalog entry.
import { normalizeSkillFiles, normalizeSkillPath } from "./files.js";
import { parseFrontmatter } from "./frontmatter.js";

export const PLUGIN_MANIFESTS = { claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json" };
const componentDefaults = { skills: "skills", commands: "commands", agents: "agents", hooks: "hooks/hooks.json", mcpServers: ".mcp.json", lspServers: ".lsp.json", apps: ".apps.json" };

function componentPath(value, files) {
  if (typeof value !== "string" || !value || value.includes(":") || value.includes("$") || value.includes("~")) throw new Error("plugin component must be a local package path");
  const p = normalizeSkillPath(value);
  if (!files.some((f) => f.path === p || f.path.startsWith(`${p}/`))) throw new Error(`plugin component path is missing: ${p}`);
  return p;
}

function describe(files) {
  const manifests = {};
  const components = Object.fromEntries(Object.keys(componentDefaults).map((k) => [k, []]));
  let name = "", description = "", version = "", manifestPath = "";
  for (const [engine, p] of Object.entries(PLUGIN_MANIFESTS)) {
    const file = files.find((f) => f.path === p);
    if (!file) continue;
    let manifest;
    try { manifest = JSON.parse(file.content.toString("utf8")); } catch { throw new Error(`invalid plugin manifest JSON: ${p}`); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(manifest.name)) throw new Error(`invalid plugin name in ${p}`);
    if (name && name !== manifest.name) throw new Error("plugin manifests must use the same name");
    for (const key of ["description", "version"]) if (manifest[key] != null && typeof manifest[key] !== "string") throw new Error(`invalid plugin ${key} in ${p}`);
    name = manifest.name;
    description ||= manifest.description || `Plugin package ${name}`;
    version ||= manifest.version || "";
    manifestPath ||= p;
    manifests[engine] = manifest;
    for (const [key, defaultPath] of Object.entries(componentDefaults)) {
      const value = manifest[key];
      if (value != null) {
        if ((["hooks", "mcpServers", "lspServers", "apps"].includes(key)) && typeof value === "object" && !Array.isArray(value)) components[key].push(p);
        else for (const entry of Array.isArray(value) ? value : [value]) components[key].push(componentPath(entry, files));
      }
      // Claude's conventional component directories remain enabled alongside custom paths.
      if (files.some((f) => f.path === defaultPath || f.path.startsWith(`${defaultPath}/`))) components[key].push(defaultPath);
    }
  }
  if (!name) throw new Error("plugin package needs a .claude-plugin/plugin.json or .codex-plugin/plugin.json manifest");
  for (const [key, extras] of Object.entries({ apps: [".app.json"], hooks: ["hooks.json"] })) {
    for (const p of extras) if (files.some((f) => f.path === p)) components[key].push(p);
  }
  for (const key of Object.keys(components)) components[key] = [...new Set(components[key])];
  return { kind: "plugin", name, description, version, engines: Object.keys(manifests), manifestPath, manifests, components, files };
}

export function buildPluginSkill(input) {
  const files = normalizeSkillFiles(input, { requireManifest: false });
  const descriptor = describe(files);
  const { name, description, version, engines, manifestPath, components } = descriptor;
  const metadata = { kind: "plugin", name, engines, manifestPath, components };
  // JSON values are also valid YAML scalars; nested metadata is emitted as a YAML mapping.
  const skillLinks = files.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path)).map((f) => `- [${f.path}](package/${f.path})`).join("\n");
  const componentLinks = [...new Set(Object.values(components).flat())].map((p) => `- [${p}](package/${p})`).join("\n");
  const header = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nversion: ${JSON.stringify(version)}\nplugin:\n  kind: plugin\n  name: ${JSON.stringify(name)}\n  engines: ${JSON.stringify(engines)}\n  manifestPath: ${JSON.stringify(manifestPath)}\n  components:\n${Object.entries(metadata.components).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\nThis entry contains the complete ${name} plugin package. Review all files under package/ before approving this revision. Enable it through the existing channel skills or templates. This file is a catalog index; native plugin execution is managed separately by the gateway.\n\nBundled skill instructions:\n${skillLinks || "No bundled skills."}\n\nSupporting components:\n${componentLinks || "No additional components."}\n`;
  return normalizeSkillFiles([{ path: "SKILL.md", content: header }, ...files.map((f) => ({ ...f, path: `package/${f.path}` }))]);
}

export function parsePluginPackage(input) {
  const files = normalizeSkillFiles(input);
  const main = files.find((f) => /^SKILL\.md$/i.test(f.path));
  const hasPackageManifest = files.some((f) => Object.values(PLUGIN_MANIFESTS).includes(f.path.slice("package/".length)) && f.path.startsWith("package/"));
  if (!hasPackageManifest && parseFrontmatter(main.content.toString("utf8")).data.plugin?.kind !== "plugin") return null;
  if (files.some((f) => f !== main && !f.path.startsWith("package/"))) throw new Error("plugin revision contains files outside package/");
  return describe(normalizeSkillFiles(files.filter((f) => f.path.startsWith("package/")).map((f) => ({ ...f, path: f.path.slice(8) })), { requireManifest: false }));
}
