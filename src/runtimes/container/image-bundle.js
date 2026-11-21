import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The checkout files OUTSIDE `containers/` that `npm run build:image` copies into the channel image
// — declared once, here, for both the builder (scripts/build-image.mjs stages exactly these) and the
// daemon (src/runtimes/container/image.js digests exactly these into `cg.image.bundle`). Built-ins
// only, so the daemon can import it without pulling in any build tooling, and an image can never be
// called current while one of the files it was built from has moved. (Changing these LISTS changes
// the digest's inputs: an updater still running the previous release computes the old set once and
// may warn that a correctly rebuilt image does not match; the next check reads it as current.)

// The engine-spawned helpers that must exist inside the image. Their relative-import CLOSURE is
// staged under /opt/channelgate with the leading `src/` stripped, so every import keeps resolving.
export const BUNDLE_ENTRIES = Object.freeze([
  "src/mcp/secret-env-bridge.js", // Codex: bundle → env → exec the real MCP command
  "src/gateway/hooks/stop-subagents.mjs", // the Claude Stop hook
]);

// Daemon-side reference implementations copied VERBATIM into bin/ as .mjs (an ES module wherever it
// sits, independent of any package.json), so the two halves of each protocol can never drift.
//  - the container half of the gateway control MCP: engines are handed `node <dest>` (Codex reaches
//    it through secret-env-bridge, which re-execs process.execPath); Composio SDK mode is a second
//    service on the same socket, so this one file serves both;
//  - the container half of the egress proxy (container-secrets P2), started by cg-init under
//    CG_EGRESS=proxy;
//  - the SSH ProxyCommand helper (container-secrets P3); containers/bin/cg-egress-connect is its
//    POSIX shim.
export const SOCKET_BRIDGE = Object.freeze({ source: "src/mcp/socket-bridge.js", dest: "bin/cg-mcp-bridge.mjs", role: "the container half of the gateway MCP" });
export const EGRESS_FORWARDER = Object.freeze({ source: "src/mcp/egress-forwarder.js", dest: "bin/cg-egress.mjs", role: "the container half of the egress proxy" });
export const EGRESS_CONNECT = Object.freeze({ source: "src/mcp/egress-connect.js", dest: "bin/cg-egress-connect.mjs", role: "the SSH ProxyCommand helper" });
export const VERBATIM_HELPERS = Object.freeze([SOCKET_BRIDGE, EGRESS_FORWARDER, EGRESS_CONNECT]);

const IMPORT_PATTERNS = [
  /(?:^|[\n;])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
  /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * The transitive closure of relative imports from `entries`, plus the bare package names it uses
 * (so the bundle's package.json declares exactly what it needs). Only explicit relative paths are
 * followed. `strict` (the builder) throws on a file that does not exist; the daemon's digest passes
 * `strict: false` and records the gap instead, so a half-written checkout reads as "stale", never as
 * a crashed health check.
 *
 * @returns {{ files: string[], packages: string[], missing: string[] }} repo-relative, forward-slashed, sorted
 */
export function resolveBundleClosure(repoRoot, entries = BUNDLE_ENTRIES, { strict = true } = {}) {
  const files = new Set();
  const packages = new Set();
  const missing = new Set();
  const queue = entries.map((rel) => ({ rel, from: null }));
  while (queue.length) {
    const { rel, from } = queue.shift();
    if (files.has(rel) || missing.has(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      if (strict) {
        throw new Error(from
          ? `${from} imports "${rel}", which does not resolve to a file — the bundler only follows explicit relative paths`
          : `bundle entry ${rel} does not exist`);
      }
      missing.add(rel);
      continue;
    }
    files.add(rel);
    const source = readFileSync(abs, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const spec = match[1];
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) {
          packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
          continue;
        }
        queue.push({ rel: toRepoPath(path.relative(repoRoot, path.resolve(path.dirname(abs), spec))), from: rel });
      }
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort(), missing: [...missing].sort() };
}

/** Every checkout file outside `containers/` that the image is built from, sorted. */
export function stagedSourceFiles(repoRoot) {
  const { files, missing } = resolveBundleClosure(repoRoot, BUNDLE_ENTRIES, { strict: false });
  return [...new Set([...files, ...missing, ...VERBATIM_HELPERS.map((h) => h.source)])].sort();
}

/**
 * sha256 over the path and bytes of every staged source file — the `cg.image.bundle` label. The
 * builder and the daemon both call THIS with the same checkout, so the label and the expectation
 * cannot disagree. A missing file hashes as a marker rather than throwing (the build itself refuses
 * to stage it, so no image can carry that value).
 *
 * The bundle's generated package.json is not part of it: its `dependencies` are the closure's
 * package imports (empty today; adding one edits a staged file, which moves this digest) and its
 * `overrides` only matter when there are dependencies. A dependency version bump with no source
 * change is what `imageSpecVersion` versions.
 */
export function bundleDigest(repoRoot) {
  const hash = createHash("sha256");
  for (const rel of stagedSourceFiles(repoRoot)) {
    const abs = path.join(repoRoot, rel);
    hash.update(rel).update("\0");
    if (existsSync(abs)) hash.update("file\0").update(readFileSync(abs));
    else hash.update("missing\0");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function toRepoPath(rel) {
  return rel.split(path.sep).join("/");
}
