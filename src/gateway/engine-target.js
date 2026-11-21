// The runtime target an engine runs in when it is not the one the target was resolved for: the
// SAME machine boundary, with the credential facts re-pointed at that engine — which login its
// container run is relayed (`meta.engine`, `codexHarness`) and which directory holds its sessions
// and sign-in (`container.codexHome`). Two callers need exactly this and must agree on it: a turn
// moving to another license of its pool (run.js), and an SSH session, whose `codex` is the
// channel's selected Codex license whatever engine the stored channel record names
// (ssh-session.js). Nothing is cached on the way: the directory is recomputed from the container's
// shared Codex home every time, so a target resolved for one license never leaks its directory
// into another's.
import { adapterFor } from "../engines/registry.js";
import { codexHarnessFor } from "./channel-codex-paths.js";

export function engineRuntimeTarget(target, engine) {
  const meta = { ...target?.meta, engine, codexHarness: codexHarnessFor(engine) };
  if (!target?.container) return { ...target, meta };
  const container = { ...target.container, codexHome: target.container.baseCodexHome || target.container.codexHome };
  const state = adapterFor(engine)?.cli === "codex" ? adapterFor(engine).sessionState : null;
  const dir = typeof state?.containerDir === "function" ? state.containerDir(container) : container[state?.containerDirKey || ""];
  if (dir) container.codexHome = dir;
  return { ...target, meta, container };
}
