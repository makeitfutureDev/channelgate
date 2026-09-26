// The container-secrets P4 static rule (scripts/static-secret-writes.mjs, run by
// `npm run check:static`): no write under a container-visible artifact path whose content comes
// from a secret resolver. Fixtures are source TEXT — nothing here is executed or written.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { findSecretArtifactWrites, ALLOW_MARKER } = await import("../scripts/static-secret-writes.mjs");
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("a resolver value written under an artifact-derived path is caught, through any number of derived names", () => {
  const fixture = [
    'import { writeFileSync } from "node:fs";',
    "export function leak(target, integrations, relay) {",
    '  const dir = path.join(target.artifactDir, "run");',
    '  const file = path.join(dir, "tokens.json");',
    "  writeFileSync(file, JSON.stringify({ t: integrations.composioUserToken }));",
    '  fs.writeFileSync(path.join(sshUserDir(target, "u"), "tok"), relay.token);',
    "  writePrivate(file, resolvedRunEnv.GITHUB_TOKEN);",
    "}",
  ].join("\n");
  const found = findSecretArtifactWrites("src/fixture.js", fixture);
  assert.equal(found.length, 3, found.join("\n"));
  assert.match(found[0], /^src\/fixture\.js:5: writeFileSync\(\) writes `composioUserToken`/);
  assert.match(found[1], /:6: writeFileSync\(\) writes `relay\.token`/);
  assert.match(found[2], /:7: writePrivate\(\) writes `resolvedRunEnv`/);
});

test("not flagged: other paths, non-secret content, and a reviewed exception", () => {
  const fixture = [
    "export function ok(target, relay, bundle) {",
    '  const dir = path.join(target.artifactDir, "run");',
    '  writeFileSync(path.join(dir, "b.json"), JSON.stringify(bundle));',
    '  writeFileSync(path.join(os.tmpdir(), "x"), relay.token);',
    `  // ${ALLOW_MARKER} — the container form: a placeholder behind the proxy`,
    '  writeFileSync(path.join(dir, "claude-token"), relay.token);',
    "}",
  ].join("\n");
  assert.deepEqual(findSecretArtifactWrites("src/ok.js", fixture), []);
});

test("the repository itself passes the rule", () => {
  const files = [];
  const walk = (rel) => {
    for (const item of readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = path.join(rel, item.name);
      if (item.isDirectory()) walk(child);
      else if (/\.(?:js|mjs)$/.test(item.name)) files.push(child);
    }
  };
  walk("src");
  const found = files.flatMap((file) => findSecretArtifactWrites(file, readFileSync(path.join(repoRoot, file), "utf8")));
  assert.deepEqual(found, []);
});
