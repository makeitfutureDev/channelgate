// The public package summary is an allowlist, never a raw manifest or connection object.
export function pluginSummaryFromMetadata(metadata) {
  const plugin = metadata?.plugin;
  if (plugin?.kind !== "plugin") return undefined;
  const text = (value) => typeof value === "string" ? value : "";
  const components = {};
  for (const key of ["skills", "commands", "agents", "hooks", "mcpServers", "apps", "lspServers"]) {
    components[key] = Array.isArray(plugin.components?.[key]) ? plugin.components[key].filter((value) => typeof value === "string") : [];
  }
  return { kind: "plugin", name: text(plugin.name), engines: Array.isArray(plugin.engines) ? plugin.engines.filter((value) => value === "claude" || value === "codex") : [], manifestPath: text(plugin.manifestPath), components };
}
