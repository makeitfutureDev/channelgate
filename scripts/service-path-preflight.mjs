// Read-only prerequisite for a not-yet-created service identity. Its new primary group cannot
// traverse an operator's private home; changing ownership of the checkout does not change that.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function privateServiceAncestor(directory) {
  let current = realpathSync(directory);
  while (true) {
    const entry = statSync(current);
    if (!entry.isDirectory() || !(entry.mode & 0o001)) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const directory of process.argv.slice(2)) {
      const blocked = privateServiceAncestor(directory);
      if (blocked) throw new Error(`the new service account cannot traverse ${blocked}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
