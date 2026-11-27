// Read-only diagnostics for legacy host folders that cannot be imported as skills.
// They remain outside the catalog and cannot be granted through this listing.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_MANIFESTS } from "./plugin-package.js";

const regularFile = async (file) => {
  try { return (await stat(file)).isFile(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) return false;
    throw error;
  }
};

export async function listSkillFolderIssues(roots) {
  const issues = new Map();
  for (const root of roots) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const folder = path.join(root, entry.name);
      if (await regularFile(path.join(folder, "SKILL.md"))) continue;
      // Native plugin packages do not require a root skill manifest.
      let plugin = false;
      for (const manifest of Object.values(PLUGIN_MANIFESTS)) {
        if (await regularFile(path.join(folder, manifest))) { plugin = true; break; }
      }
      if (plugin) continue;
      let issue = issues.get(entry.name);
      if (!issue) {
        issue = { slug: entry.name, name: entry.name, missingSkillMd: true, diagnosticOnly: true, folderPaths: [] };
        issues.set(entry.name, issue);
      }
      issue.folderPaths.push(folder);
    }
  }
  return [...issues.values()];
}
