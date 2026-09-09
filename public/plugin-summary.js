// Metadata only: never display raw plugin manifests, which may contain connection secrets.
import { escapeHtml as esc } from "./admin-view.js";

function pluginOf(item) {
  const plugin = item?.plugin || item?.meta?.plugin;
  return plugin?.kind === "plugin" ? plugin : null;
}

export function pluginBadge(item) {
  return pluginOf(item) ? ' <span class="pill">Plugin</span>' : "";
}

export function pluginSummary(item) {
  const plugin = pluginOf(item);
  if (!plugin) return "";
  const labels = { skills: "Skills", commands: "Commands", agents: "Agents", hooks: "Hooks", mcpServers: "MCP servers", apps: "Apps (unsupported)", lspServers: "LSP servers (unsupported)" };
  const components = Object.entries(labels).flatMap(([key, label]) => {
    const paths = Array.isArray(plugin.components?.[key]) ? plugin.components[key].filter((p) => typeof p === "string") : [];
    return paths.length ? [`<dt>${label}</dt><dd>${paths.map((path) => `<code>${esc(path)}</code>`).join(", ")}</dd>`] : [];
  }).join("");
  const engines = Array.isArray(plugin.engines) ? plugin.engines.filter((e) => e === "claude" || e === "codex").map((e) => e === "claude" ? "Claude" : "Codex") : [];
  return `<div class="skills-plugin-summary"><dl><dt>Plugin manifests</dt><dd>${engines.join(", ") || "Unknown"}</dd>${components}</dl><p class="skills-note">Engine compatibility is checked when the conversation runs. Skills work with Claude and Codex; native components depend on the selected engine. Unsupported components stop the run with a reason. Hooks require an authorized admin turn in a Full-access conversation.</p><p class="skills-note">The whole package shares one approval and grant, including its declared MCP tools. Hooks and server commands can execute code inside the conversation container. Required accounts and credentials must be configured separately; enabling a plugin does not connect them.</p></div>`;
}
