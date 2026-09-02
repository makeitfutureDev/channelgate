// The `host` runtime backend: today's behaviour, unchanged — a direct child_process.spawn on the
// daemon's PATH, a kill(pid, 0) liveness probe, and a negative-pid group kill. Admin channels pin
// this backend (plan §5/§9), and the gateway-wide kill switch returns every channel to it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "../util/proc.js";
import { pidAlive } from "../engines/watchdog.js";
import { attachRuntime } from "./contract.js";
import { copyCarryEntries } from "./copy.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Today's absolute script paths, resolved from this checkout (never from the cwd).
const HOST_HELPERS = Object.freeze({
  "gateway-mcp": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "gateway-server.js")] }),
  "secret-env-bridge": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "secret-env-bridge.js")] }),
  "composio-sdk-bridge": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "composio-sdk-bridge.js")] }),
  "stop-subagents-hook": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "gateway", "hooks", "stop-subagents.mjs")] }),
  // The host runners keep resolving the pinned mcp-remote themselves (src/mcp/remote-secret-bridge.js);
  // this entry exists so a caller can ask uniformly.
  "mcp-remote": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "remote-secret-bridge.js")] }),
});

export const hostBackend = Object.freeze({
  id: "host",
  capabilities: Object.freeze({
    isolated: false,
    processGroups: true,
    detachedSurvivesDaemon: true,
    persistentHome: false,
  }),

  prepareTarget(base) {
    return { ...base, backend: "host", runtime: hostBackend, container: null, artifactDir: null };
  },

  async ensureUp() {
    return { created: false, started: false, warmupMs: 0 };
  },

  spawn(target, spec) {
    const child = spawn(spec.cmd, spec.args || [], {
      cwd: spec.cwd || target.cwd,
      env: spec.env,
      stdio: spec.stdio || ["ignore", "pipe", "pipe"],
      // Every engine child is its own process group so killTree can take MCP stdio grandchildren
      // and mcp-remote bridges with it (src/util/proc.js).
      detached: spec.detached !== false,
    });
    return attachRuntime(child, { backend: hostBackend, runId: spec.runId, target, kind: spec.kind });
  },

  async probe(child) {
    return pidAlive(child?.pid);
  },

  async signal(child, signal = "SIGTERM") {
    return killTree(child, signal);
  },

  acquireLease() {
    return { release() {} };
  },

  async destroy() {},

  fingerprint() {
    return "host";
  },

  async describe() {
    return { backend: "host", state: "host" };
  },

  resumeCommand(target, { baseCommand }) {
    return baseCommand;
  },

  helperCommand(target, name) {
    const make = HOST_HELPERS[name];
    if (!make) throw new TypeError(`unknown runtime helper "${name}"`);
    return make();
  },

  // The carry pair (contract.js OPTIONAL_METHODS). For the host there is no boundary to cross —
  // "into the runtime" and "out of the runtime" are both a copy on the daemon's own filesystem —
  // so both directions are the same call. They exist so the orchestrator never has to ask which
  // backend it is talking to.
  async copyIn(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },

  async copyOut(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },
});
