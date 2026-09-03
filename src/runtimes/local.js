// The daemon's OWN process spawner. NOT a channel runtime backend: since 2026-09-03 every channel
// turn runs in the container backend (src/runtimes/container/), and this module exists only for the
// few processes the daemon itself runs on its own host — the transactional updater's Claude smoke
// probe and the direct-runner tests. It is deliberately not registered in ./registry.js, so no
// channel can ever resolve to it, and it declares `isolated: false` so a runner that receives it
// knows there is no container boundary around the child.
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
    return { release() {} };
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
    throw new TypeError(`runtime helper "${name}" is only available inside a channel container`);
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
