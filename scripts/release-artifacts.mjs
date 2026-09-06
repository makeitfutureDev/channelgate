import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist", "release"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockText = readFileSync(path.join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
mkdirSync(out, { recursive: true });
const ref = (location) => location ? `npm-lock:${location}` : "channelgate";
const components = Object.entries(lock.packages || {})
  .filter(([location, value]) => location && value?.version)
  .map(([location, value]) => {
    const name = value.name || location.split("node_modules/").at(-1);
    const purl = `pkg:npm/${name.replace("@", "%40")}@${value.version}`;
    const integrity = /^(sha256|sha384|sha512)-([^ ]+)/.exec(value.integrity || "");
    return {
      type: "library", "bom-ref": ref(location), name, version: value.version, purl,
      ...(value.license ? { licenses: [{ expression: value.license }] } : {}),
      ...(integrity ? { hashes: [{ alg: integrity[1].toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(integrity[2], "base64").toString("hex") }] } : {}),
      properties: [{ name: "npm:lockfile:path", value: location }],
    };
  }).sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
function dependencyRef(location, name) {
  let cursor = location;
  while (true) {
    const candidate = path.posix.join(cursor, "node_modules", name);
    if (lock.packages[candidate]) return ref(candidate);
    if (!cursor) return null;
    cursor = path.posix.dirname(cursor);
    if (cursor === ".") cursor = "";
  }
}
const inventory = {
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", "bom-ref": ref(""), name: pkg.name, version: pkg.version },
    properties: [{ name: "channelgate:scope", value: "npm lockfile only; excludes runtime image, OS, Python, model weights and global CLIs" }] },
  components,
  dependencies: Object.entries(lock.packages).map(([location, value]) => ({
    ref: ref(location), dependsOn: [...new Set(Object.keys({ ...value.dependencies, ...value.optionalDependencies, ...(location ? {} : value.devDependencies) })
      .map((name) => dependencyRef(location, name)).filter(Boolean))].sort(),
  })),
};
const metadata = {
  description: "Unsigned local build metadata. GitHub release workflow separately signs artifact attestations.",
  version: pkg.version, sourceRevision: git("rev-parse", "HEAD"),
  sourceDirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
  packageLockSha256: sha256(lockText),
};
for (const [name, value] of [["npm-lock-inventory.cdx.json", inventory], ["build-metadata.json", metadata]]) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path.join(out, name), data);
  writeFileSync(path.join(out, `${name}.sha256`), `${sha256(data)}  ${name}\n`);
}
console.log(`Npm lockfile inventory and unsigned build metadata written to ${out}`);
