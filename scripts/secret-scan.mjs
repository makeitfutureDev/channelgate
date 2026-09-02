#!/usr/bin/env node
// Minimal, dependency-free secret scan over git-tracked files. Run by CI (and locally via
// `node scripts/secret-scan.mjs`). Fails with exit 1 when a string shaped like a real credential
// is found. Patterns are deliberately strict (length + structure) so documentation placeholders
// like `xoxb-…`, `sk-ant-x`, or test fixtures ("xoxb-test") never trip it — a noisy scanner gets
// ignored, a quiet one gets trusted.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

// Binary/asset extensions and generated files that cannot leak our secrets but are large/noisy.
const SKIP = /\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|mp[34]|webm|svg)$/i;
const SKIP_FILES = new Set(["package-lock.json"]);
const MAX_BYTES = 2 * 1024 * 1024;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", cwd: repoRoot })
  .split("\0")
  .filter((f) => f && !SKIP.test(f) && !SKIP_FILES.has(f));

let findings = 0;
for (const file of files) {
  const abs = path.join(repoRoot, file);
  let stats;
  try {
    stats = statSync(abs);
  } catch {
    continue; // deleted but still listed
  }
  if (!stats.isFile() || stats.size > MAX_BYTES) continue;
  const content = readFileSync(abs, "utf8");
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      // Report the location and pattern only — never echo the matched value.
      console.error(`SECRET? ${file}:${line} matches "${name}"`);
      findings += 1;
    }
  }
}

if (findings > 0) {
  console.error(`\nSecret scan failed: ${findings} finding(s). If a match is a deliberate fake, make it obviously fake (shorter, or with an invalid character) instead of allowlisting.`);
  process.exit(1);
}
console.log(`Secret scan clean (${files.length} tracked files checked).`);
