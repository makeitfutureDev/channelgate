// READING engine state where it lies — the container half of `inspectState` (../contract.js).
//
// The carry pair moves files; this one only looks. It exists because the daemon cannot open a
// channel's HOME volume at all: rootless Podman creates `<volume root>/<name>/` owned by the
// mapped sub-uid with mode 0700, so even though `_data` and the transcripts inside it belong to
// the daemon's own uid, the directory above them cannot be traversed. `/resume` adoption has to
// answer "does this session exist in this channel, and which cwd was it started in?" — and under
// containers-only that question can only be put to the container.
//
// One `sh -c` answers it: expand the caller's globs (only the inside can), and for every match
// print a marker line carrying the mtime and the path, followed by the opening lines of the file.
// The marker is random per call, so no transcript content can forge a record boundary, and the
// per-file byte and line caps keep a multi-megabyte transcript from being read back wholesale —
// the fields adoption needs (`cwd`, the session id) are in the first records.
import { randomBytes } from "node:crypto";
import { shellQuote, shellQuoteGlob } from "./carry.js";

// A look, not a copy: it must not outlive the `/resume` the user is waiting on.
export const INSPECT_TIMEOUT_MS = 30_000;

// How much of a transcript comes back per match. 50 lines matches the host-side scan in
// session-adopt.js; the byte cap is the guard for a single enormous line (a tool result can be a
// megabyte on its own) and may truncate the last line, which the JSON parsing already tolerates.
export const INSPECT_MAX_LINES = 50;
export const INSPECT_MAX_BYTES = 512_000;

export function newInspectMarker() {
  return `cg-state-${randomBytes(8).toString("hex")}`;
}

/**
 * The `sh -c` script that lists and heads every match INSIDE the container. Every path is quoted
 * except the wildcards, and a test asserts on it verbatim and then runs it.
 */
export function buildInspectScript(globs = [], marker, { maxLines = INSPECT_MAX_LINES, maxBytes = INSPECT_MAX_BYTES } = {}) {
  const lines = [];
  for (const glob of globs) {
    if (!glob) continue;
    // An unmatched glob expands to the pattern itself in sh, hence the existence test.
    lines.push(`for f in ${shellQuoteGlob(glob)}; do`);
    lines.push('  if [ -f "$f" ]; then');
    lines.push(`    printf '%s %s %s\\n' ${shellQuote(marker)} "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"`);
    // `head -c` before `head -n` so a single huge line is capped before it is ever read out; the
    // trailing newline guarantees the next marker line starts a line of its own.
    lines.push(`    head -c ${Number(maxBytes) || INSPECT_MAX_BYTES} "$f" 2>/dev/null | head -n ${Number(maxLines) || INSPECT_MAX_LINES} 2>/dev/null || true`);
    lines.push("    printf '\\n'");
    lines.push("  fi");
    lines.push("done");
  }
  lines.push("exit 0");
  return lines.join("\n");
}

/**
 * Parse that script's stdout back into `[{ path, mtimeMs, head }]`. A marker line is
 * `<marker> <mtime seconds> <path>`; everything until the next marker line is that file's head.
 * Anything before the first marker line is not ours and is dropped.
 */
export function parseInspectOutput(stdout, marker) {
  const out = [];
  let current = null;
  for (const line of String(stdout || "").split("\n")) {
    if (line.startsWith(`${marker} `)) {
      const rest = line.slice(marker.length + 1);
      const cut = rest.indexOf(" ");
      if (cut <= 0) continue;
      const seconds = Number(rest.slice(0, cut));
      current = { path: rest.slice(cut + 1), mtimeMs: Number.isFinite(seconds) ? seconds * 1000 : 0, head: [] };
      out.push(current);
      continue;
    }
    if (current) current.head.push(line);
  }
  return out;
}

export function createContainerState({ exec, lifecycle, log = () => {} } = {}) {
  /**
   * @param {object} target
   * @param {object} request
   * @param {string[]} request.globs   absolute IN-CONTAINER paths, `*` inside a segment
   * @returns {Promise<Array<{ path: string, mtimeMs: number, head: string[] }>>}
   */
  async function inspectState(target, { globs = [], maxLines = INSPECT_MAX_LINES, maxBytes = INSPECT_MAX_BYTES } = {}) {
    const patterns = (globs || []).map((glob) => String(glob || "")).filter(Boolean);
    if (!patterns.length) return [];
    if (!target?.container?.name) throw new Error("this target has no container to inspect");
    // The state outlives the container on purpose (it is in the volume), so a stopped container is
    // the normal case here, exactly as it is for a carry. runExec's own self-heal covers the
    // container that vanishes between the two calls.
    await lifecycle.ensureUp(target, {});
    const marker = newInspectMarker();
    const result = await exec.runExec(target, [target.container.name, "/bin/sh", "-c", buildInspectScript(patterns, marker, { maxLines, maxBytes })], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`reading engine state in ${target.container.name} failed: ${String(result.stderr || "").trim() || `exit ${result.code}`}`);
    }
    const found = parseInspectOutput(result.stdout, marker);
    log(`[container] inspected ${patterns.length} state pattern${patterns.length === 1 ? "" : "s"} in ${target.container.name}: ${found.length} match${found.length === 1 ? "" : "es"}`);
    return found;
  }

  return { inspectState };
}
