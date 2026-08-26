import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist", "release"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockText = readFileSync(path.join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
mkdirSync(out, { recursive: true });

const components = Object.entries(lock.packages || {})
  .filter(([name, value]) => name && value?.version)
  .map(([name, value]) => ({ type: "library", name: name.replace(/^node_modules\//, ""), version: value.version }))
  .sort((a, b) => a.name.localeCompare(b.name));
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", name: pkg.name, version: pkg.version } },
  components,
};
writeFileSync(path.join(out, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

const provenance = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: "package-lock.json", digest: { sha256: sha256(lockText) } }],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: { buildType: "https://github.com/makeitfutureDev/channelgate/release-artifacts/v1", externalParameters: { version: pkg.version } },
    runDetails: { builder: { id: process.env.GITHUB_WORKFLOW_REF || "local-untrusted-builder" }, metadata: { invocationId: process.env.GITHUB_RUN_ID || "local" } },
  },
};
writeFileSync(path.join(out, "provenance.intoto.jsonl"), `${JSON.stringify(provenance)}\n`);
for (const name of ["sbom.cdx.json", "provenance.intoto.jsonl"]) {
  const data = readFileSync(path.join(out, name));
  writeFileSync(path.join(out, `${name}.sha256`), `${sha256(data)}  ${name}\n`);
}
console.log(`Release artifacts written to ${out}`);
