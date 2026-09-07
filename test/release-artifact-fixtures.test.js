import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { tempDir } from "./helpers.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const token = "gh" + "p_" + "A".repeat(36);
const key = ["-----BEGIN PRIVATE KEY-----", "A".repeat(64), "B".repeat(64), "-----END PRIVATE KEY-----"].join("\n");
function fixture() {
  const root = tempDir("cg-artifact-fixtures-");
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "artifacts"));
  copyFileSync(new URL("../scripts/secret-scan.mjs", import.meta.url), path.join(root, "scripts/secret-scan.mjs"));
  writeFileSync(path.join(root, "scripts/reviewed-artifact-fixtures.json"), JSON.stringify([
    { pattern: "GitHub token", sha256: sha256(token) },
    { pattern: "Private key block", sha256: sha256(key) },
  ]));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, stdio: "pipe" });
  git("init"); git("add", "scripts"); git("commit", "-m", "safe scanner fixture");
  const run = (...args) => spawnSync(process.execPath, ["scripts/secret-scan.mjs", ...args], { cwd: root, encoding: "utf8" });
  return { root, git, run };
}

test("reviewed public fixtures are waived only in artifacts, never tracked files or history", () => {
  const { root, git, run } = fixture();
  const contents = `${token}\n${key}\n`;
  writeFileSync(path.join(root, "artifacts/public.bin"), contents);
  let result = run("--artifacts", "artifacts");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 exact reviewed public artifact fixtures/);
  writeFileSync(path.join(root, "source.txt"), contents); git("add", "source.txt");
  result = run("--artifacts", "artifacts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source.txt/);
  assert.ok(!result.stderr.includes(token));
  assert.ok(!result.stderr.includes("A".repeat(64)));
  git("commit", "-m", "fixture containing credential-shaped source");
  unlinkSync(path.join(root, "source.txt")); git("add", "source.txt"); git("commit", "-m", "remove fixture");
  result = run("--history", "--artifacts", "artifacts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /history:/);
  assert.equal((result.stderr.match(/SECRET\?/g) || []).length, 2);
});

test("same-prefix changed PEM, incomplete PEM and unknown token cannot inherit a public waiver", () => {
  const { root, run } = fixture();
  const changed = key.replace("B".repeat(64), "C".repeat(64));
  const incomplete = key.slice(0, key.indexOf("-----END"));
  const unknownToken = token.slice(0, -1) + "Z";
  writeFileSync(path.join(root, "artifacts/unknown.bin"), `${changed}\n${incomplete}\n${unknownToken}\n`);
  const result = run("--artifacts", "artifacts");
  assert.equal(result.status, 1);
  assert.equal((result.stderr.match(/SECRET\?/g) || []).length, 3, result.stderr);
  assert.ok(!result.stderr.includes(unknownToken));
  assert.ok(!result.stderr.includes("C".repeat(64)));
});

test("gzip streams preserve full-key decisions and one finding across read/lookahead boundaries", () => {
  const { root, run } = fixture();
  // The token crosses the 64 KiB read boundary. The PEM's known first line is in a previous
  // chunk to its changed body/end: waiving its prefix before reading that body would be unsafe.
  const changed = key.replace("B".repeat(64), "D".repeat(64));
  const contents = " ".repeat(65536 - 10) + token + "\n" + " ".repeat(65536 - token.length - 40) + changed + "\n" + key;
  writeFileSync(path.join(root, "artifacts/boundary.bin.gz"), gzipSync(contents));
  let result = run("--artifacts", "artifacts");
  assert.equal(result.status, 1);
  assert.equal((result.stderr.match(/SECRET\?/g) || []).length, 1, result.stderr);
  writeFileSync(path.join(root, "artifacts/boundary.bin.gz"), gzipSync(contents.replace(changed, key)));
  result = run("--artifacts", "artifacts");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 exact reviewed public artifact fixtures/);
});


test("word-boundary detection retains the byte before a stream cut", () => {
  const { root, run } = fixture();
  const googleShaped = "AI" + "za" + "A".repeat(35);
  // An adjoining word character means this is not a Google-key pattern, including when the
  // scanner advances its retained window immediately before the key-shaped substring.
  writeFileSync(path.join(root, "artifacts/word-boundary.bin"), " ".repeat(65535) + "x" + googleShaped + " ".repeat(131072));
  const result = run("--artifacts", "artifacts");
  assert.equal(result.status, 0, result.stderr);
});
