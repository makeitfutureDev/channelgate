// Moving ENGINE STATE across the container boundary — the container half of the carry contract
// (`copyIn` / `copyOut` in ../contract.js).
//
// The daemon cannot read or write the channel's HOME volume directly: the volume's directory chain
// is owned by the sub-uid root, and `podman unshare` is not an option (Docker has no equivalent).
// What IS shared is `target.artifactDir` — bind-mounted rw at the IDENTICAL absolute path, written
// by the daemon and read by the agent — so every carry goes through a staging directory under it:
//
//   copyIn   daemon stages the files → ONE `sh -c` inside copies them into place → staging removed
//   copyOut  ONE `sh -c` inside stages the files → daemon moves them into place → staging removed
//
// The staging tree always MIRRORS THE DESTINATION absolute path (`<staging>/home/agent/.claude/…`
// going in, `<staging>/home/management/.channelgate/…` coming out). That single convention is what
// lets the receiving side apply a carry by walking, with no second copy of the path arithmetic and
// no knowledge of which entry a staged file came from — which matters because the container side
// expands wildcards the daemon cannot (a Codex rollout's timestamped filename).
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { carrySegments, copyCarryPair, expandCarryEntry, hasWildcard, splitCarryPath, walkFiles } from "../copy.js";

// A carry copies transcripts, not a repository: generous, but never unbounded.
export const CARRY_TIMEOUT_MS = 120_000;

export function shellQuote(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// Quote a path that must still GLOB: every literal run is quoted, the `*` characters stay bare.
// Adjacent quoted and bare parts concatenate into one shell word, so a directory containing a
// space is still a single argument while the wildcard is still expanded by the shell.
export function shellQuoteGlob(pattern) {
  return String(pattern ?? "")
    .split("*")
    .map((part) => (part === "" ? "" : shellQuote(part)))
    .join("*");
}

// Where a single carry stages its files. Under the artifact dir because that is the ONE directory
// both sides can write; a fresh id per carry so two concurrent threads never collide.
export function carryStagingDir(target, id) {
  return path.join(String(target?.artifactDir || ""), "carry", id);
}

function newCarryId() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

// The staged mirror of an absolute destination path: `<staging>` + the destination path itself.
function stagedPath(stagingDir, destination) {
  return path.join(stagingDir, String(destination).replace(/^[/\\]+/, ""));
}

/**
 * The `sh -c` script that applies an already-staged copyIn INSIDE the container. Every path is
 * literal and quoted — the script is auditable, and a test asserts on it verbatim.
 */
export function buildCopyInScript(pairs = []) {
  const lines = ["set -e"];
  for (const { staged, to, kind } of pairs) {
    if (kind === "dir") {
      // `cp -a src/. dst/` MERGES: same-named files are replaced, anything else in dst is left
      // alone, and dst is never nested inside itself the way `cp -a src dst` would do when dst
      // already exists.
      lines.push(`mkdir -p ${shellQuote(to)}`);
      lines.push(`cp -a ${shellQuote(`${staged}/.`)} ${shellQuote(`${to}/`)}`);
    } else {
      lines.push(`mkdir -p ${shellQuote(path.posix.dirname(to))}`);
      lines.push(`cp -a ${shellQuote(staged)} ${shellQuote(to)}`);
    }
  }
  lines.push("exit 0");
  return lines.join("\n");
}

/**
 * The `sh -c` script that STAGES a copyOut inside the container. Wildcards are expanded here,
 * by the shell, because only this side can see the files; each match is staged at its DESTINATION
 * path so the daemon can drain the tree without knowing what matched.
 */
export function buildCopyOutScript(entries = [], stagingDir) {
  const lines = ["set -e"];
  for (const entry of entries) {
    const rel = String(entry.rel || "");
    const depth = carrySegments(rel).length;
    if (!hasWildcard(rel)) {
      const staged = stagedPath(stagingDir, entry.to);
      const test = entry.kind === "dir" ? "-d" : "-e";
      lines.push(`if [ ${test} ${shellQuote(entry.from)} ]; then`);
      if (entry.kind === "dir") {
        lines.push(`  mkdir -p ${shellQuote(staged)}`);
        lines.push(`  cp -a ${shellQuote(`${entry.from}/.`)} ${shellQuote(`${staged}/`)}`);
      } else {
        lines.push(`  mkdir -p ${shellQuote(path.posix.dirname(staged))}`);
        lines.push(`  cp -a ${shellQuote(entry.from)} ${shellQuote(staged)}`);
      }
      lines.push("fi");
      continue;
    }
    // A pattern: the container-side root is stripped off each match and the tail re-applied under
    // the staged mirror of the destination root, so the rollout keeps its YYYY/MM/DD directory.
    const [fromRoot] = splitCarryPath(entry.from, depth, "/");
    const [toRoot] = splitCarryPath(entry.to, depth, "/");
    const stagedRoot = stagedPath(stagingDir, toRoot);
    lines.push(`for f in ${shellQuoteGlob(entry.from)}; do`);
    lines.push('  if [ -e "$f" ]; then');
    lines.push(`    d=${shellQuote(stagedRoot)}/\${f#${shellQuote(`${fromRoot}/`)}}`);
    lines.push('    mkdir -p "${d%/*}"');
    lines.push('    cp -a "$f" "$d"');
    lines.push("  fi");
    lines.push("done");
  }
  lines.push("exit 0");
  return lines.join("\n");
}

// The destination roots a carry is allowed to write on the daemon's filesystem: the roots the
// CALLER declared, and nothing else. Everything a copyOut writes is named by a file the container
// staged, and a container is not trusted to choose a path on the host — a staged
// `etc/cron.d/…` would otherwise be a write outside the engine's state dir.
function destinationRoots(entries = []) {
  const roots = new Set();
  for (const entry of entries || []) {
    const depth = carrySegments(entry?.rel || "").length;
    const [root] = splitCarryPath(String(entry?.to || ""), depth, "/");
    if (root) roots.add(path.resolve(root));
  }
  return [...roots];
}

function withinRoots(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

export function createContainerCarry({ exec, lifecycle, log = () => {} } = {}) {
  // A carry may run against a container the idle reaper has stopped — that is rather the point:
  // the history lives in a volume that outlives the container. Bringing it up is the backend's own
  // job (the caller holds a lease around the whole carry so the reaper cannot stop it again
  // mid-copy). `retry` keeps the out-of-band-removal self-heal every other exec has.
  async function runScript(target, script) {
    await lifecycle.ensureUp(target, {});
    return exec.runExec(target, [target.container.name, "/bin/sh", "-c", script], {
      timeoutMs: CARRY_TIMEOUT_MS,
    });
  }

  function cleanup(dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`[container] could not remove the carry staging dir ${dir}: ${error?.message || error}`);
    }
  }

  async function copyIn(target, entries = []) {
    if (!target?.artifactDir) throw new Error("this target has no artifact dir — a carry has nowhere to stage");
    const stagingDir = carryStagingDir(target, newCarryId());
    try {
      // Wildcards on the HOST side are expanded here; the container script only ever sees concrete
      // paths on the way in.
      const pairs = [];
      let copied = 0;
      for (const entry of entries || []) {
        for (const pair of expandCarryEntry(entry)) {
          const staged = stagedPath(stagingDir, pair.to);
          const wrote = copyCarryPair({ from: pair.from, to: staged, kind: pair.kind });
          if (!wrote) continue;
          copied += wrote;
          pairs.push({ staged, to: pair.to, kind: pair.kind });
        }
      }
      if (!pairs.length) return { copied: 0 };
      const result = await runScript(target, buildCopyInScript(pairs));
      if (result.code !== 0) {
        throw new Error(`copying session state into ${target.container.name} failed: ${String(result.stderr || "").trim() || `exit ${result.code}`}`);
      }
      return { copied };
    } finally {
      cleanup(stagingDir);
    }
  }

  async function copyOut(target, entries = []) {
    if (!target?.artifactDir) throw new Error("this target has no artifact dir — a carry has nowhere to stage");
    const stagingDir = carryStagingDir(target, newCarryId());
    try {
      mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
      const result = await runScript(target, buildCopyOutScript(entries, stagingDir));
      if (result.code !== 0) {
        throw new Error(`copying session state out of ${target.container.name} failed: ${String(result.stderr || "").trim() || `exit ${result.code}`}`);
      }
      // The staged tree mirrors destination paths, so draining it needs no entry bookkeeping: every
      // staged file goes to the absolute path it mirrors — as long as that path is inside a root
      // the caller actually asked for.
      const roots = destinationRoots(entries);
      let copied = 0;
      for (const rel of walkFiles(stagingDir)) {
        const to = path.resolve("/", rel);
        if (!withinRoots(to, roots)) {
          log(`[container] refusing a carried file outside the requested state dirs: ${to}`);
          continue;
        }
        copied += copyCarryPair({ from: path.join(stagingDir, rel), to, kind: "file" });
      }
      return { copied };
    } finally {
      cleanup(stagingDir);
    }
  }

  return { copyIn, copyOut, carryStagingDir };
}
