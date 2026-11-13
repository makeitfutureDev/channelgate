// One answer to "how does THIS thread's session get reopened in a terminal?", shared by the
// /menu card's Resume button and the Channel Settings → Diagnostics page. Both used to resolve
// it themselves, and a second copy is how the two drift over which engine minted the session or
// whether the command has to exec into the channel's container.
//
// The session is read at DISPLAY time (never carried in a button value), so a stale card can
// neither resurrect a cleared session nor point at another thread. `cleanMode` is applied from
// the thread's own flag because a clean thread runs in a different folder, and the resume command
// has to name the folder the session was actually minted in.
import { buildResumeCommand } from "./footer.js";
import { getSession, getSessionEngine, getSessionRuntime } from "../gateway/sessions.js";
import { effectiveWorkDir } from "../gateway/folders.js";
import { getThreadClean, resolveThreadEngine } from "../gateway/thread-engine.js";
import { resolveRuntime } from "../runtimes/resolve.js";

// Returns { inThread, sessionId, engine, workDir, command, shellCommand, hostCommand, runtimeScope }.
// `command` is "" whenever there is nothing to resume — outside a thread, or in a thread that has
// not run a turn yet. `shellCommand` is the engine's own `cd "<folder>" && <engine> --resume <id>`
// line, which is what a shell ALREADY inside the channel's container runs (an SSH session or VS
// Code attached to it); `hostCommand` is the backend's wrapped form (`podman exec … <shell line>`)
// for a terminal on the gateway machine, and "" when the two are the same (a host runtime).
// `command` stays the form the gateway recommends by default — the wrapped one where it exists —
// because /menu, `/resume`, the Teams settings card and the web UI all print exactly that.
const NOTHING = Object.freeze({ sessionId: "", engine: "", workDir: "", command: "", shellCommand: "", hostCommand: "", runtimeScope: "" });

export async function resolveResumeSession({ entry, meta, isAdminAuthor = false }, threadTs = "") {
  const inThread = Boolean(threadTs);
  const slug = entry?.slug || "";
  if (!inThread || !slug) return { inThread, ...NOTHING };
  // A conversation that has no stored metadata yet still has a default work folder; every reader
  // below treats a missing record as "nothing configured" rather than throwing on it.
  const base = meta || {};
  const channelMeta = await getThreadClean(slug, threadTs) ? { ...base, cleanMode: true } : base;
  const sessionId = (await getSession(slug, threadTs)) || "";
  if (!sessionId) return { inThread, ...NOTHING };
  // The engine that MINTED the session wins over the thread's resolved default: a session id is
  // engine-specific, so a Claude session must never be printed as a `codex exec resume` line.
  const engine = (await getSessionEngine(slug, threadTs)) || await resolveThreadEngine(slug, threadTs, channelMeta);
  const workDir = effectiveWorkDir(slug, channelMeta);
  // WHERE the channel runs decides the shape of the command: a session minted inside the
  // channel's container cannot be reopened by a bare CLI on the host. A resolve failure falls
  // back to the host form rather than leaving the user with no command at all.
  const stamp = await getSessionRuntime(slug, threadTs);
  const adminSession = stamp?.scope !== "project";
  const runtimeScope = adminSession ? "admin" : "project";
  if (adminSession && !isAdminAuthor) return { inThread, ...NOTHING, sessionId, engine, workDir, runtimeScope };
  let target = null;
  try { target = resolveRuntime(slug, channelMeta, { isAdminAuthor: adminSession }); } catch { /* fall back to the host form */ }
  const shellCommand = buildResumeCommand(workDir, sessionId, engine, null);
  const command = buildResumeCommand(workDir, sessionId, engine, target);
  return { inThread, sessionId, engine, workDir, command, shellCommand, hostCommand: command !== shellCommand ? command : "", runtimeScope };
}
