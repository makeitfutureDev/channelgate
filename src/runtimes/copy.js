// Host-side file movement for the CARRY contract (`copyIn` / `copyOut` — see contract.js).
//
// The host backend IS this module, and the container backend uses the same code for the half of a
// carry that happens on the daemon's filesystem (staging into, and draining out of, the shared
// artifact dir). One implementation of the wildcard expansion and of the overwrite rule, on this
// side of the boundary — the other side is a shell script in container/carry.js.
//
// Two rules the whole feature rests on, enforced here:
//   • OVERWRITE, never delete. A file replaces the file at its destination; a directory is MERGED
//     into the destination directory (same-named files replaced, everything else left alone). The
//     stored session row names where the NEWEST copy lives, so overwriting the older side is
//     correct — but nothing on either side is ever removed, so a mistake costs a stale copy and
//     never a conversation.
//   • A missing source is not an error. A thread whose engine files were never written (or were
//     already cleaned up by the engine) simply carries nothing, and the caller falls back to the
//     existing heal.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A CarryEntry. `from` and `to` are ABSOLUTE paths on their own side of the copy and end with the
 * same relative tail, `rel`.
 *
 * `rel` may contain `*` INSIDE a path segment (never `**`, never across a separator): Codex names
 * a rollout file after a timestamp nobody can recompute, so its location is a pattern rather than
 * a path. The pattern is expanded on the side that OWNS the files and the matched tail is applied
 * verbatim to the other side — which is exactly what keeps a rollout's YYYY/MM/DD directory
 * intact, without which `codex exec resume` cannot find it.
 *
 * @typedef {object} CarryEntry
 * @property {string} from   absolute source path (may contain `*` in the `rel` tail)
 * @property {string} to     absolute destination path (the same `rel` tail under the other root)
 * @property {string} rel    the shared relative tail, `/`-separated
 * @property {"file"|"dir"} kind
 */

export function carrySegments(rel) {
  return String(rel || "").split("/").filter(Boolean);
}

export function hasWildcard(rel) {
  return String(rel || "").includes("*");
}

// `*` matches within one segment only. Everything else in the segment is literal.
function segmentMatcher(segment) {
  const source = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

// Split an absolute path into [root, tail], where `tail` is its last `depth` segments. Both sides
// of a carry are POSIX (the daemon and every container run on Linux), so the
// separator is the same on both — `sep` exists so a caller can be explicit rather than lucky.
export function splitCarryPath(abs, depth, sep = path.sep) {
  const parts = String(abs).split(sep);
  if (depth <= 0 || depth >= parts.length) return [String(abs), ""];
  return [parts.slice(0, parts.length - depth).join(sep), parts.slice(parts.length - depth).join(sep)];
}

// Every FILE under `root`, as `/`-separated paths relative to it. Used to count what a carry
// actually moved and to drain a staging directory.
export function walkFiles(root, prefix = "") {
  const base = prefix ? path.join(root, prefix) : root;
  let items = [];
  try {
    items = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Expand ONE entry into concrete `{ from, to, kind }` pairs on the local filesystem, dropping any
 * source that does not exist. An entry with no wildcard is either itself or nothing.
 */
export function expandCarryEntry(entry, { sep = path.sep } = {}) {
  const rel = String(entry?.rel || "");
  const depth = carrySegments(rel).length;
  if (!hasWildcard(rel)) {
    return existsSync(entry.from) ? [{ from: entry.from, to: entry.to, kind: entry.kind }] : [];
  }
  const [fromRoot] = splitCarryPath(entry.from, depth, sep);
  const [toRoot] = splitCarryPath(entry.to, depth, sep);
  let current = [fromRoot];
  for (const segment of carrySegments(rel)) {
    const next = [];
    if (!segment.includes("*")) {
      for (const base of current) next.push(path.join(base, segment));
    } else {
      const matches = segmentMatcher(segment);
      for (const base of current) {
        let names = [];
        try {
          names = readdirSync(base);
        } catch {
          continue; // an intermediate directory that does not exist matches nothing
        }
        for (const name of names.sort()) if (matches.test(name)) next.push(path.join(base, name));
      }
    }
    current = next;
  }
  return current
    .filter((abs) => existsSync(abs))
    .map((abs) => {
      const [, tail] = splitCarryPath(abs, depth, sep);
      return { from: abs, to: path.join(toRoot, tail), kind: entry.kind };
    });
}

export function expandCarryEntries(entries = []) {
  const out = [];
  for (const entry of entries || []) out.push(...expandCarryEntry(entry));
  return out;
}

// Copy one already-expanded pair. Returns how many FILES it wrote.
export function copyCarryPair({ from, to, kind }) {
  if (!existsSync(from)) return 0;
  if (kind === "dir") {
    if (!statSync(from).isDirectory()) return 0;
    mkdirSync(to, { recursive: true });
    // Node's `cp` merges src's children into dest (it never creates dest/<basename>), which is the
    // overwrite-without-delete rule above. Symlinks inside stay symlinks: following them could
    // walk a loop, and an engine transcript tree contains none.
    cpSync(from, to, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
    return walkFiles(from).length;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  // A single file is dereferenced on purpose: a transcript reached through a symlink must arrive
  // as CONTENT, or the copy would dangle the moment it lands on the other side of a boundary.
  cpSync(from, to, { force: true, dereference: true, preserveTimestamps: true });
  return 1;
}

// The whole host-side copy: expand, then copy. Returns the number of files written.
export function copyCarryEntries(entries = []) {
  let copied = 0;
  for (const pair of expandCarryEntries(entries)) copied += copyCarryPair(pair);
  return copied;
}
