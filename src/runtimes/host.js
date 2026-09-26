// Direct host runtime, reachable only through an admin-authenticated thread `/sudo` decision.
// The engine is a child of the daemon account: there is no container filesystem or process
// boundary, and the backend intentionally preserves the host cwd, HOME, PATH and process tree.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "../util/proc.js";
import { pidAlive } from "../engines/watchdog.js";
import { attachRuntime } from "./contract.js";
import { copyCarryEntries } from "./copy.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_HELPERS = Object.freeze({
  "gateway-mcp": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "gateway-server.js")] }),
  "secret-env-bridge": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "mcp", "secret-env-bridge.js")] }),
  "composio-sdk-bridge": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "ee", "composio-sdk-bridge.js")] }),
  "stop-subagents-hook": () => ({ command: process.execPath, args: [path.join(SRC_ROOT, "gateway", "hooks", "stop-subagents.mjs")] }),
});

export const hostBackend = Object.freeze({
  id: "host",
  capabilities: Object.freeze({
    isolated: false,
    processGroups: true,
    detachedSurvivesDaemon: true,
    persistentHome: true,
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
    return { id: "", release() {} };
  },

  async destroy() {},

  fingerprint() {
    return "host";
  },

  async describe() {
    return { backend: "host", state: "direct host", reason: "sudo thread" };
  },

  resumeCommand(target, { baseCommand }) {
    return baseCommand;
  },

  helperCommand(target, name) {
    const make = HOST_HELPERS[name];
    if (!make) throw new TypeError(`unknown runtime helper "${name}"`);
    return make();
  },

  async copyIn(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },

  async copyOut(target, entries = []) {
    return { copied: copyCarryEntries(entries) };
  },
});
