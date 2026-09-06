#!/usr/bin/env node
// Dependency-free scan of tracked files, candidate history and release artifacts. Run by CI (and locally via
// `node scripts/secret-scan.mjs`). Fails with exit 1 when a string shaped like a real credential
// is found. Patterns are deliberately strict (length + structure) so documentation placeholders
// like `xoxb-…`, `sk-ant-x`, or test fixtures ("xoxb-test") never trip it — a noisy scanner gets
// ignored, a quiet one gets trusted.
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Scan the REPO the script belongs to, not whatever cwd it was invoked from.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PATTERNS = [
  // Slack bot/user/app-level tokens (real ones carry numeric segments + a long suffix).
  { name: "Slack token", re: /xox[bpars]-[0-9]{8,}-[0-9A-Za-z-]{20,}/g },
  { name: "Slack rotation token", re: /xoxe(?:\.xox[bp])?-[0-9]-[A-Za-z0-9-]{40,}/g },
  { name: "Slack webhook URL", re: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g },
  { name: "Slack app-level token", re: /xapp-[0-9]-[A-Z0-9]{8,}-[0-9]{10,}-[a-f0-9]{32,}/g },
  // Anthropic / OpenAI project keys.
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  { name: "OpenAI project key", re: /sk-proj-[A-Za-z0-9_-]{32,}/g },
  // GitHub personal/OAuth/server tokens.
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{50,}/g },
  // Cloud provider keys.
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // A private key block with an actual base64 body (a bare BEGIN line in a fixture is fine).
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=]{60,}/g },
];

// Never exempt lockfiles, assets or large blobs: credentials can appear in any of them.
// History means commits reachable from this release candidate, not the private archive remote.
const args = process.argv.slice(2);
const artifactsAt = args.indexOf("--artifacts");
const artifactDir = artifactsAt >= 0 ? args[artifactsAt + 1] : null;
if (artifactsAt >= 0 && !artifactDir) throw new Error("--artifacts requires a directory");
let findings = 0;
let checked = 0;
function scan(content, label, overlap = 0) {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      if (match.index + match[0].length <= overlap) continue;
      findings += 1;
      if (findings <= 100) console.error(`SECRET? ${safeLabel(label)} matches "${name}"`);
    }
  }
}
function safeLabel(label) {
  let value = String(label);
  for (const { re } of PATTERNS) value = value.replace(new RegExp(re.source, re.flags), "[redacted]");
  return value;
}
async function scanFile(file, label) {
  // Streaming keeps image archives and other large release assets bounded in memory.
  let stream = createReadStream(file);
  if (file.endsWith(".gz")) stream = stream.pipe(createGunzip());
  let tail = "";
  for await (const chunk of stream) {
    const content = tail + chunk.toString("latin1");
    scan(content, label, tail.length);
    tail = content.slice(-2048);
  }
  checked += 1;
}
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", cwd: repoRoot }).split("\0").filter(Boolean);
for (const file of files) {
  const abs = path.join(repoRoot, file);
  let stat;
  try { stat = lstatSync(abs); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  // Symlink targets are path text in git; never follow one into a private host directory.
  if (stat.isSymbolicLink()) { scan(readlinkSync(abs), file); checked += 1; }
  else if (stat.isFile()) await scanFile(abs, file);
}
if (args.includes("--history")) {
  const objects = execFileSync("git", ["rev-list", "--objects", "HEAD"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const names = new Map(objects.trim().split("\n").map((line) => { const [id, ...name] = line.split(" "); return [id, name.join(" ")]; }));
  // Annotated tags pointing at the candidate are published too, but private archive tags are not.
  const tags = execFileSync("git", ["for-each-ref", "--points-at", "HEAD", "--format=%(objectname) %(objecttype)", "refs/tags"], { cwd: repoRoot, encoding: "utf8" });
  for (const line of tags.trim().split("\n")) {
    const [id, type] = line.split(" ");
    if (type !== "tag") continue;
    const message = execFileSync("git", ["cat-file", "tag", id], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    scan(message, `tag:${id.slice(0, 12)}`);
    checked += 1;
  }
  const types = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: repoRoot, input: [...names.keys()].join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of types.trim().split("\n")) {
    const [id, type] = line.split(" ");
    if (!["blob", "commit"].includes(type)) continue;
    const child = spawn("git", ["cat-file", type, id], { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] });
    const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git cat-file failed (${code})`))); });
    let tail = "";
    for await (const chunk of child.stdout) { const content = tail + chunk.toString("latin1"); scan(content, `history:${id.slice(0, 12)}:${names.get(id)}`, tail.length); tail = content.slice(-2048); }
    await completion;
    checked += 1;
  }
}
async function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) await scanFile(file, `artifact:${path.relative(repoRoot, file)}`);
    else if (entry.isSymbolicLink()) throw new Error(`Release artifact must not be a symlink: ${entry.name}`);
  }
}
if (artifactDir) await walk(path.resolve(repoRoot, artifactDir));
if (findings) {
  console.error(`Secret scan failed: ${findings} finding(s). Values are never printed. Review the reported objects before publication.`);
  process.exitCode = 1;
} else console.log(`Secret scan clean (${checked} files/blobs checked${args.includes("--history") ? ", including candidate history" : ""}).`);
