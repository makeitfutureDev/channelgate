// A fake RuntimeBackend for the orchestration tests (test/runtime-integration-*.test.js).
//
// The container backend needs docker/podman, an image and a kernel that allows it — none of which
// a test suite may depend on. What the ORCHESTRATION side has to prove is different anyway, and is
// entirely about ordering and plumbing: is ensureUp awaited before anything spawns, is a lease held
// for the whole turn and released on every exit, do the engine-facing files land under the mounted
// artifact dir, does a missing credential end the turn before a spawn. All of that is observable
// through the contract, so the fake implements the contract, records every call, and delegates the
// actual spawn to the host backend so the turn really runs.
//
// It validates against src/runtimes/contract.js on construction: a fake that drifted from the
// contract would prove the wrong thing.
import path from "node:path";
import { attachRuntime, validateRuntimeBackend } from "../src/runtimes/contract.js";
import { copyCarryEntries } from "../src/runtimes/copy.js";
import { localRuntime } from "../src/runtimes/local.js";
import { resolveRuntime } from "../src/runtimes/resolve.js";

export const FAKE_IMAGE = "channelgate/runtime:test";
export const FAKE_CONTAINER = "cg-test-fake";

export function createFakeRuntimeBackend({
  isolated = true,
  // (target, engine) → "" | "why this run cannot authenticate"
  credentialError = null,
  ensureUpError = null,
  ensureUpDelayMs = 0,
  helpers = {},
} = {}) {
  // One shared counter so "did ensureUp happen before the spawn?" is answerable, not inferable.
  let seq = 0;
  // Delegated children that have exited, by runId: a background job inside a container is watched
  // by PROBE (the daemon-side client exits as soon as the exec is started), so the fake's probe
  // must say "gone" once the process it really spawned has finished — otherwise a job could never
  // complete. `alive = false` still overrides it (a vanished container).
  const exited = new Set();
  const calls = {
    ensureUp: [],
    spawn: [],
    leases: [],
    released: [],
    probe: [],
    signal: [],
    announced: [],
    copyIn: [],
    copyOut: [],
  };

  const backend = {
    id: "container",
    capabilities: Object.freeze({
      isolated,
      processGroups: true,
      detachedSurvivesDaemon: true,
      persistentHome: isolated,
    }),
    // Test knobs, read by probe(). Extra properties are fine — the contract validates methods and
    // capability keys, not the absence of state.
    alive: true,
    calls,

    prepareTarget(base) {
      return {
        ...base,
        backend: "container",
        runtime: backend,
        container: isolated
          ? {
            name: FAKE_CONTAINER, image: FAKE_IMAGE, home: "/home/agent", homeVolume: `${FAKE_CONTAINER}-home`,
            // The engine state dirs the image declares (src/runtimes/container/image-paths.js) —
            // the real ones, because callers read them off the target. A carry to one of these
            // lands in the fake's stand-in filesystem instead; see fakeContainerPath().
            claudeConfigDir: "/home/agent/.claude",
            codexHome: "/home/agent/.codex",
          }
          : null,
      };
    },

    async ensureUp(target, { announce } = {}) {
      calls.ensureUp.push({ seq: ++seq, slug: target.slug, spawnsBefore: calls.spawn.length });
      if (ensureUpError) throw new Error(ensureUpError);
      if (ensureUpDelayMs) {
        announce?.("Warming up the channel container…");
        calls.announced.push("Warming up the channel container…");
        await new Promise((resolve) => setTimeout(resolve, ensureUpDelayMs));
      }
      return { created: calls.ensureUp.length === 1, started: true, warmupMs: ensureUpDelayMs };
    },

    spawn(target, spec) {
      calls.spawn.push({ seq: ++seq, cmd: spec.cmd, args: [...(spec.args || [])], cwd: spec.cwd, env: spec.env, runId: spec.runId, kind: spec.kind, detached: spec.detached });
      // The runners hand an isolated target the IMAGE's environment (HOME=/home/agent, the image's
      // PATH, the container tmpdir) — correct for a real container, and unrunnable on the host this
      // fake actually spawns on. Put the host's own locations back for the delegated spawn only:
      // the recorded call above still holds exactly what the runner asked for, which is what the
      // tests assert on.
      const env = spec.env && isolated
        ? { ...spec.env, PATH: process.env.PATH || "", HOME: process.env.HOME || spec.env.HOME, TMPDIR: process.env.TMPDIR || "/tmp" }
        : spec.env;
      const child = localRuntime.spawn(target, { ...spec, env });
      child.once?.("exit", () => { if (spec.runId) exited.add(spec.runId); });
      return attachRuntime(child, { backend, runId: spec.runId, target, kind: spec.kind });
    },

    async probe(child) {
      const runId = child?.runtime?.runId || "";
      calls.probe.push(runId);
      return backend.alive && !(runId && exited.has(runId));
    },

    async signal(child, signal) {
      calls.signal.push({ runId: child?.runtime?.runId || "", signal });
      // The delegated process is a real child of this host: deliver the signal to its group exactly
      // as the real backend would inside the container. Recording alone would let a stub that waits
      // forever (a cancelled turn, a wedged 401 retry loop) outlive the test that spawned it.
      await localRuntime.signal(child, signal);
      return true;
    },

    acquireLease(target, lease) {
      const record = { ...lease, released: false };
      calls.leases.push(record);
      return {
        id: `${lease?.kind || "run"}:${lease?.id || ""}`,
        release() {
          record.released = true;
          calls.released.push(record);
        },
      };
    },

    async destroy() {},

    // The carry pair. A real container stages through the bind-mounted artifact dir and execs a
    // copy inside; the fake's "inside" is a scratch mirror on this filesystem, so the copy itself
    // is the shared host-side implementation and only the boundary is faked. The RECORDED entries
    // are the ones the orchestrator asked for — container paths and all — which is what the tests
    // assert on; only the copy is redirected.
    async copyIn(target, entries = []) {
      calls.copyIn.push({ seq: ++seq, entries: entries.map((e) => ({ ...e })) });
      return { copied: copyCarryEntries(entries.map((e) => ({ ...e, to: fakeContainerPath(target, e.to) }))) };
    },

    async copyOut(target, entries = []) {
      calls.copyOut.push({ seq: ++seq, entries: entries.map((e) => ({ ...e })) });
      return { copied: copyCarryEntries(entries.map((e) => ({ ...e, from: fakeContainerPath(target, e.from) }))) };
    },

    fingerprint() {
      return `container:${FAKE_IMAGE}`;
    },

    async describe() {
      return {
        backend: "container",
        state: "running",
        containerName: FAKE_CONTAINER,
        image: FAKE_IMAGE,
        upSince: new Date(Date.now() - 90_000).toISOString(),
        warm: true,
      };
    },

    resumeCommand(target, { baseCommand }) {
      return isolated ? `docker exec -it ${FAKE_CONTAINER} ${baseCommand}` : baseCommand;
    },

    helperCommand(target, name) {
      if (helpers[name]) return helpers[name];
      const image = {
        "stop-subagents-hook": { command: "/opt/channelgate/bin/cg-stop-subagents", args: [] },
        "gateway-mcp": { command: "cg-mcp-bridge", args: [] },
        "secret-env-bridge": { command: "node", args: ["/opt/channelgate/mcp/secret-env-bridge.js"] },
        "composio-sdk-bridge": { command: "node", args: ["/opt/channelgate/mcp/composio-sdk-bridge.js"] },
        "mcp-remote": { command: "mcp-remote", args: [] },
      };
      if (!image[name]) throw new TypeError(`unknown runtime helper "${name}"`);
      return image[name];
    },
  };

  if (credentialError) backend.credentialError = credentialError;
  validateRuntimeBackend(backend);
  return backend;
}

// Where a path INSIDE the fake's container actually lives on this machine. A real container's
// `/home/agent/.claude` is unreachable from the daemon (the HOME volume is owned by the sub-uid
// root); the fake mirrors it under the channel's artifact dir so a test can plant a transcript
// "in the container" and read back what a carry delivered.
export function fakeContainerPath(target, abs) {
  return path.join(target.artifactDir || "", "fake-container-fs", String(abs).replace(/^[/\\]+/, ""));
}

// A RuntimeTarget whose PATHS come from the real resolver (so the artifact/clean dirs are exactly
// the ones production would use) but whose backend is the fake.
export function fakeTarget(backend, slug, meta = {}) {
  const real = resolveRuntime(slug, meta);
  return backend.prepareTarget({ ...real, meta, runtime: backend });
}

// Route every channel turn of the calling test file through a fake backend: the orchestration
// (src/gateway/run.js) resolves targets through its test seam, so a suite with no container CLI
// still runs every stub-engine turn "inside" a container-shaped target. Returns the backend so a
// test can assert on its recorded calls. Undo with `await useFakeRuntime(null)`.
export async function useFakeRuntime(backend = createFakeRuntimeBackend()) {
  const { setRuntimeResolver } = await import("../src/gateway/run.js");
  setRuntimeResolver(backend ? (slug, meta) => fakeTarget(backend, slug, meta) : null);
  return backend;
}

export { localRuntime };
