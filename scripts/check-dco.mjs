#!/usr/bin/env node
// Developer Certificate of Origin / CLA acceptance gate. Every commit we merge must carry a
// `Signed-off-by:` trailer, because that trailer IS the acceptance of `CLA.md` (Section 7) —
// without it the Licensor cannot relicense the contribution, which is the whole point of
// collecting it up front. Dependency-free on purpose: CI runs this before `npm ci`, and a
// licensing gate that a registry outage can break is not a gate.
//
// Usage: node scripts/check-dco.mjs [<base>..<head>]   (default: origin/main..HEAD)
// Exit 0 when every commit in the range is signed off, exit 1 listing the ones that are not.
//
// Merge commits are exempt: GitHub and `git merge` generate them, nobody authors them, and the
// commits they carry are checked individually.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RANGE = "origin/main..HEAD";

// A trailer is only a trailer at the start of its own line. The name must be non-empty and the
// address must look like a real mailbox — `Signed-off-by: <>`, `Signed-off-by: Someone` and
// `Signed-off-by: Someone <nope>` are the malformed forms this deliberately rejects: an
// unreachable or anonymous sign-off cannot be accepted (CLA.md Section 7).
const TRAILER = /^signed-off-by:[ \t]+(\S.*?)[ \t]*<([^<>\s]+)>[ \t\r]*$/i;
const MAILBOX = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

/**
 * True when a commit message carries at least one well-formed sign-off trailer.
 * Pure: it takes the raw commit message and touches nothing else.
 */
export function hasSignOff(message) {
  if (typeof message !== "string") return false;
  return message.split(/\r?\n/).some((line) => {
    const match = TRAILER.exec(line);
    if (!match) return false;
    const [, name, email] = match;
    return name.trim().length > 0 && MAILBOX.test(email);
  });
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// ASCII unit/record separators: a commit subject or body can hold any printable text, but never
// these two bytes, so they delimit the `git log` output unambiguously.
const UNIT = "\u001f";
const RECORD = "\u001e";

/** Read `{ hash, subject, message }` for every non-merge commit in a range. */
export function commitsInRange(range, cwd = repoRoot) {
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--format=%H${UNIT}%s${UNIT}%B${RECORD}`, range],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split(RECORD)
    .map((record) => record.replace(/^[\r\n]+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash, subject, message] = record.split(UNIT);
      return { hash, subject, message: message ?? "" };
    });
}

function main(argv) {
  const range = argv[0] || DEFAULT_RANGE;
  let commits;
  try {
    commits = commitsInRange(range);
  } catch (error) {
    console.error(`check-dco: cannot read commits for "${range}": ${String(error.message).trim()}`);
    return 1;
  }

  const offenders = commits.filter((commit) => !hasSignOff(commit.message));
  if (offenders.length > 0) {
    console.error(`Missing "Signed-off-by" trailer on ${offenders.length} commit(s) in ${range}:`);
    for (const commit of offenders) console.error(`  ${commit.hash.slice(0, 12)} ${commit.subject}`);
    console.error("");
    console.error("That trailer is how a contribution accepts CLA.md (Section 7). Add it with:");
    console.error("  git commit -s                  # new commits");
    console.error("  git rebase --signoff <base>    # commits you already made");
    return 1;
  }

  console.log(`DCO check passed: ${commits.length} commit(s) in ${range} carry a sign-off trailer.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
