// Run inside the newly built image with a read-only root and no network. Syft inventories
// installed packages; this supplement binds non-package model files to their actual bytes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat, readlink } from "node:fs/promises";
import path from "node:path";
const root = "/opt/channelgate/models";
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isSymbolicLink()) files.push({ path: path.relative(root, file), linkTarget: await readlink(file) });
    else if (entry.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.push({ path: path.relative(root, file), bytes: (await lstat(file)).size, sha256: hash.digest("hex") });
    }
  }
}
await walk(root);
console.log(JSON.stringify({ root, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2));
