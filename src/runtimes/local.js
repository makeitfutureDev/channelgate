// The daemon's internal process spawner. This is NOT the registered `/sudo` host backend: it exists
// for the transactional updater's Claude smoke probe and direct-runner tests, has no engine helper
// catalog, and cannot be selected by a channel turn. Direct host turns use ./host.js instead.
import { spawn } from "node:child_process";
import { killTree } from "../util/proc.js";
import { pidAlive } from "../engines/watchdog.js";
import { attachRuntime } from "./contract.js";
import { copyCarryEntries } from "./copy.js";

export const localRuntime = Object.freeze({
  id: "local",
  capabilities: Object.freeze({
    isolated: false,
    processGroups: true,
    detachedSurvivesDaemon: true,
    persistentHome: false,
  }),

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
    return attachRuntime(child, { backend: localRuntime, runId: spec.runId, target, kind: spec.kind });
  },

  async probe(child) {
    return pidAlive(child?.pid);
  },

  async signal(child, signal = "SIGTERM") {
    return killTree(child, signal);
  },

  acquireLease() {
    return { id: "", release() {} };
  },

  async destroy() {},

  fingerprint() {
    return "local";
  },

  async describe() {
    return { backend: "local", state: "local" };
  },

  resumeCommand(target, { baseCommand }) {
    return baseCommand;
  },

  helperCommand(target, name) {
    throw new TypeError(`runtime helper "${name}" is unavailable in the daemon-internal local runtime`);
  },

  // Both carry directions are a copy on the daemon's own filesystem here; they exist so a caller
  // never has to ask which runtime it is talking to.
  async copyIn(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },

  async copyOut(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },
});
