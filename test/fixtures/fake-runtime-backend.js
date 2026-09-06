// A RuntimeBackend (src/runtimes/contract.js) with no operating system behind it: it records the
// spawn specs and signals it is handed, hands back a ChildProcess-shaped object the test drives by
// hand, and answers probes from a script. Everything the engine runners do to a process now goes
// through this surface, so a fake that satisfies the contract is enough to prove a runner crossed
// the seam — no container binary, and no real engine CLI, involved.
//
// Lives under test/fixtures/ on purpose: scripts/run-tests.mjs only collects test/*.test.js, so
// this module is importable from several test files without its tests running twice.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { attachRuntime, validateRuntimeBackend } from "../../src/runtimes/contract.js";

const IMAGE_BIN = "/opt/channelgate";

export function createFakeRuntime({
  id = "container",
  isolated = true,
  fingerprint = "container:fp-1",
  credentialError = null, // Error or string → the backend reports this engine's credential as unusable
  nodeBin = "/usr/local/bin/node",
} = {}) {
  const spawns = [];
  const signals = [];
  const children = [];
  const probes = [];
  let probeAnswer = () => true;

  const backend = {
    id,
    capabilities: {
      isolated,
      processGroups: true,
      detachedSurvivesDaemon: true,
      persistentHome: isolated,
    },
    prepareTarget(base) {
      return { ...base, backend: id, runtime: backend, container: { name: "cg-test-channel" } };
    },
    async ensureUp() {
      return { created: false, started: false, warmupMs: 0 };
    },
    spawn(target, spec) {
      spawns.push({ ...spec, args: [...(spec.args || [])], env: { ...spec.env } });
      const child = new EventEmitter();
      child.pid = 90_000 + spawns.length;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.kill = (signal = "SIGTERM") => {
        signals.push({ via: "kill", runId: spec.runId, signal });
        return true;
      };
      attachRuntime(child, { backend, runId: spec.runId, target, kind: spec.kind });
      children.push(child);
      return child;
    },
    async probe(child) {
      probes.push(child?.runtime?.runId || "");
      return probeAnswer(child);
    },
    async signal(child, signal) {
      signals.push({ via: "backend", runId: child?.runtime?.runId || "", signal });
      return true;
    },
    acquireLease() {
      return { id: "", release() {} };
    },
    async destroy() {},
    fingerprint() {
      return fingerprint;
    },
    async describe() {
      return { backend: id, state: "running", containerName: "cg-test-channel" };
    },
    resumeCommand(target, { baseCommand }) {
      return `podman exec -it -w ${target.cwd} cg-test-channel ${baseCommand}`;
    },
    // The image's baked helper bundle. secret-env-bridge re-execs its target with node, so the
    // gateway helper is expressed as node + a script path exactly as it is on the host.
    helperCommand(target, name) {
      const helpers = {
        "gateway-mcp": { command: nodeBin, args: [`${IMAGE_BIN}/bin/cg-mcp-bridge.js`] },
        "secret-env-bridge": { command: nodeBin, args: [`${IMAGE_BIN}/mcp/secret-env-bridge.js`] },
        "composio-sdk-bridge": { command: nodeBin, args: [`${IMAGE_BIN}/mcp/composio-sdk-bridge.js`] },
        "stop-subagents-hook": { command: nodeBin, args: [`${IMAGE_BIN}/hooks/stop-subagents.mjs`] },
        "mcp-remote": { command: nodeBin, args: [`${IMAGE_BIN}/mcp/remote-secret-bridge.js`] },
      };
      const helper = helpers[name];
      if (!helper) throw new TypeError(`unknown runtime helper "${name}"`);
      return helper;
    },
  };
  if (credentialError !== null) backend.credentialError = async () => credentialError;
  validateRuntimeBackend(backend);

  return {
    backend,
    spawns,
    signals,
    children,
    probes,
    setProbe(fn) {
      probeAnswer = typeof fn === "function" ? fn : () => fn;
    },
    target(overrides = {}) {
      return backend.prepareTarget({
        backend: id,
        runtime: backend,
        reason: "channel",
        slug: "rt-channel",
        platform: "slack",
        meta: {},
        cwd: "/work/rt-channel",
        workDir: "/work/rt-channel",
        cleanWorkDir: "/work/clean/rt-channel",
        artifactDir: "/gw/.runtime/slack/rt-channel",
        settings: {},
        container: null,
        ...overrides,
      });
    },
  };
}
