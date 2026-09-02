// The turn half of the container runtime (v0.8 P1): what runMessage does with the RuntimeTarget it
// resolves once per turn. Driven end-to-end through a FAKE backend (test/runtime-fake.js) so the
// ordering guarantees are observed rather than inferred — the real backend needs docker, an image
// and a permissive kernel, none of which a test suite may require.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const scratch = ensureTestEnv();
// Every Claude turn authenticates with a RELAY of the gateway's resolved login (see
// src/gateway/claude-login.js + claude-token-relay.js). Seed BOTH candidate files, in the state the
// live gateways were actually found in: an engine-home copy whose session hard-expired, and a valid
// operator login beside it. The operator's must win — that is the whole point of the resolver —
// and it is what lets these turns reach the seams the tests below assert on.
const OPERATOR_RELAY_TOKEN = "sk-ant-oat01-operator-relay";
{
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { claudeCredentialsFile } = await import("../src/runtimes/container/credentials.js");
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const write = (file, oauth) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 });
  };
  write(claudeCredentialsFile(), { accessToken: "sk-ant-oat01-stale-engine-home", expiresAt: Date.now() - 3600_000, refreshTokenExpiresAt: Date.now() - 3600_000 });
  write(path.join(operatorClaudeConfigDir(), ".credentials.json"), { accessToken: OPERATOR_RELAY_TOKEN, expiresAt: Date.now() + 4 * 3600_000, refreshTokenExpiresAt: Date.now() + 20 * 24 * 3600_000 });
}
process.env.CG_WORKSPACE_DIR = path.join(scratch, "runtime-run-workspaces");

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, setRuntimeResolver, runArtifactRoot } = await import("../src/gateway/run.js");
const { getSessionRuntime } = await import("../src/gateway/sessions.js");
const { readEvents } = await import("../src/util/logger.js");
const { runTmpDir, claudeEngineHome } = await import("../src/config/paths.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { createFakeRuntimeBackend, fakeContainerPath, fakeTarget, hostTarget, FAKE_IMAGE } = await import("./runtime-fake.js");

async function channel(id, name, meta = {}) {
  await setUser("U_RT", { name: "Runtime User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const full = { channelId: id, name, type: "channel", template: "custom", engine: "claude", allowedMcps: [], platform: "slack", ...meta };
  await saveChannelMeta(entry.slug, full);
  await mkdir(resolveRuntime(entry.slug, full).cwd, { recursive: true });
  return { entry, meta: full };
}

// Route every turn in a test through `backend`, with the real resolver supplying the paths. The
// third argument is resolveRuntime's own options object: the session carry-over asks this same seam
// for the channel's OTHER environment with an explicit `{ backend }`, so both sides of a carry come
// from the fake rather than only the one this turn runs on.
function useBackend(backend, { record = null } = {}) {
  setRuntimeResolver((slug, meta, { backend: forced = "" } = {}) => {
    if (!forced) record?.push(meta);
    if (forced === "host") return hostTarget(slug, meta);
    if (forced === "container") return fakeTarget(backend || createFakeRuntimeBackend(), slug, meta);
    return backend ? fakeTarget(backend, slug, meta) : hostTarget(slug, meta);
  });
}

test.afterEach(() => setRuntimeResolver(null));

test("an isolated turn warms the runtime up, holds a run lease, and releases it", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const backend = createFakeRuntimeBackend();
  useBackend(backend);
  const { entry } = await channel("C_RT_LEASE", "rt-lease");

  const result = await runMessage({ channelId: "C_RT_LEASE", authorId: "U_RT", text: "hello runtime", threadKey: "9100.001", origin: "slack_foreground", preferCold: true });

  assert.match(result.content, /Stub engine reply/);
  assert.equal(backend.calls.ensureUp.length, 1, "the runtime is made ready exactly once per turn");
  assert.deepEqual(backend.calls.leases.map((l) => l.kind), ["run"]);
  assert.equal(backend.calls.leases[0].released, true, "the lease is released when the turn ends");
  assert.match(backend.calls.leases[0].id, /^run-/);
  // The lease is taken BEFORE the environment is warmed: the idle reaper must not be able to stop
  // a runtime between ensureUp and the spawn that was waiting for it.
  assert.ok(backend.calls.ensureUp[0].seq > 0);
  // The result names where it ran, for the reply footer and every delivery surface downstream.
  assert.equal(result.runtime.backend, "container");
  assert.equal(result.runtime.isolated, true);
  assert.equal(result.runtime.image, FAKE_IMAGE);
  void entry;
});

test("a HOST Claude turn relays the OPERATOR's login — the engine home no longer carries one", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
  // A fake backend that declares itself NOT isolated: run.js treats it as a host turn (no container
  // fail-closed, host paths, the stable engine home) while the spawn is still recorded.
  const backend = createFakeRuntimeBackend({ isolated: false });
  useBackend(backend);
  await channel("C_RT_HOSTLOGIN", "rt-hostlogin");

  await runMessage({ channelId: "C_RT_HOSTLOGIN", authorId: "U_RT", text: "hello", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });

  const spawned = backend.calls.spawn.at(-1);
  assert.equal(spawned.cmd, "claude");
  // The whole point: the engine-home file seeded above is hard-expired, the operator's is valid,
  // and the child is handed the OPERATOR's access token rather than being left to read a dead copy.
  assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, OPERATOR_RELAY_TOKEN);
  assert.ok(!spawned.env.CLAUDE_CODE_OAUTH_TOKEN.includes("stale-engine-home"));
  // …while the child still runs under the gateway's own synthetic config dir, as it always has.
  assert.equal(spawned.env.CLAUDE_CONFIG_DIR, path.join(claudeEngineHome(), ".claude"));
});

test("a runtime that cannot start ends the turn with its own error, before the engine runs", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
  const backend = createFakeRuntimeBackend({ ensureUpError: "no container CLI on PATH" });
  useBackend(backend);
  await channel("C_RT_DOWN", "rt-down");

  await assert.rejects(
    runMessage({ channelId: "C_RT_DOWN", authorId: "U_RT", text: "hello", threadKey: "9100.002", origin: "slack_foreground", preferCold: true }),
    /no container CLI on PATH/,
  );
  // ensureUp is AWAITED before the spawn — a runtime that never came up cannot have run anything.
  assert.equal(backend.calls.spawn.length, 0);
  // …and the lease it took on the way in is still handed back.
  assert.equal(backend.calls.leases.at(-1).released, true);
});

test("a missing engine credential fails the turn closed before anything starts, and never fails over", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: true, codexEnabled: true });
  const message = "This channel runs in a container, but no Claude token is configured.";
  const backend = createFakeRuntimeBackend({ credentialError: (target, engine) => (engine === "claude" ? message : "") });
  useBackend(backend);
  await channel("C_RT_NOCRED", "rt-nocred");

  await assert.rejects(
    runMessage({ channelId: "C_RT_NOCRED", authorId: "U_RT", text: "hello", threadKey: "9100.003", origin: "slack_foreground", preferCold: true }),
    (error) => {
      assert.match(error.message, /no Claude token is configured/);
      // A configuration problem is not an engine outage: nothing about it is replay-safe provider
      // failure, so the cross-engine failover must not treat it as one.
      assert.equal(error.details.runtimeCredential, true);
      assert.equal(error.details.providerError, undefined);
      return true;
    },
  );
  // Nothing was started, warmed, or spawned: the check runs before the runtime is even asked to.
  assert.equal(backend.calls.ensureUp.length, 0);
  assert.equal(backend.calls.spawn.length, 0);
});

test("the per-run MCP config lands under the artifact dir for an isolated target and in run-tmp on the host", () => {
  const backend = createFakeRuntimeBackend();
  const isolated = fakeTarget(backend, "rt-mcp", { platform: "slack" });
  assert.equal(runArtifactRoot(isolated), isolated.artifactDir);
  assert.notEqual(runArtifactRoot(isolated), runTmpDir());
  assert.equal(runArtifactRoot(hostTarget("rt-mcp", { platform: "slack" })), runTmpDir());
  assert.equal(runArtifactRoot(null), runTmpDir(), "a caller with no target keeps today's location");
});

test("the session row and the run_config event both record where the turn ran", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const backend = createFakeRuntimeBackend();
  useBackend(backend);
  const { entry } = await channel("C_RT_SESSION", "rt-session");

  await runMessage({ channelId: "C_RT_SESSION", authorId: "U_RT", text: "hello", threadKey: "9100.004", origin: "slack_foreground", preferCold: true });

  const stamp = await getSessionRuntime(entry.slug, "9100.004");
  assert.equal(stamp.backend, "container");
  assert.equal(stamp.image, FAKE_IMAGE);
  assert.equal(stamp.fingerprint, `container:${FAKE_IMAGE}`);

  const config = readEvents({ limit: 50 }).find((e) => e.event === "run_config" && e.slug === entry.slug);
  assert.equal(config.runtime, "container");
  assert.equal(config.runtimeReason, "channel");
});

test("a host turn keeps a host session stamp and today's artifact locations", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  useBackend(null);
  const { entry } = await channel("C_RT_HOST", "rt-host-turn");

  const result = await runMessage({ channelId: "C_RT_HOST", authorId: "U_RT", text: "hello", threadKey: "9100.005", origin: "slack_foreground", preferCold: true });
  assert.match(result.content, /Stub engine reply/);
  assert.equal(result.runtime.backend, "host");
  assert.equal(result.runtime.isolated, false);
  assert.equal(result.runtime.image, "");

  const stamp = await getSessionRuntime(entry.slug, "9100.005");
  assert.deepEqual(stamp, { backend: "host", fingerprint: "host", image: "" });
});

test("a per-run mode override cannot move a turn between runtime backends", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const backend = createFakeRuntimeBackend();
  const seen = [];
  useBackend(backend, { record: seen });
  // An admin-mode channel pins the host backend (resolveRuntime §4). `mode:"read"` clears adminMode
  // for the run — it must not thereby become a container turn, or an API caller would be choosing
  // its own confinement by naming a lower capability tier.
  await channel("C_RT_OVERRIDE", "rt-override", { adminMode: true, runtime: "container" });

  await runMessage({
    channelId: "C_RT_OVERRIDE", authorId: "U_RT", text: "hello", threadKey: "9100.006",
    origin: "api_foreground", untrustedPrincipal: true, overrides: { mode: "read" }, preferCold: true,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].adminMode, true, "the backend decision reads the CHANNEL's adminMode, not the overridden view");
  assert.equal(seen[0].runtime, "container", "…and the channel's own runtime pin");
});

test("a slow cold start announces itself once; a fast one stays silent", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const fast = createFakeRuntimeBackend();
  useBackend(fast);
  await channel("C_RT_FAST", "rt-fast");
  const quiet = [];
  await runMessage({ channelId: "C_RT_FAST", authorId: "U_RT", text: "hi", threadKey: "9100.007", origin: "slack_foreground", preferCold: true, onEvent: (e) => quiet.push(e) });
  assert.equal(quiet.filter((e) => e.kind === "notice" && /Warming up/.test(e.text)).length, 0, "a warm channel must not narrate a start nobody waited for");

  const slow = createFakeRuntimeBackend({ ensureUpDelayMs: 2_400 });
  useBackend(slow);
  await channel("C_RT_SLOW", "rt-slow");
  const loud = [];
  await runMessage({ channelId: "C_RT_SLOW", authorId: "U_RT", text: "hi", threadKey: "9100.008", origin: "slack_foreground", preferCold: true, onEvent: (e) => loud.push(e) });
  const notices = loud.filter((e) => e.kind === "notice" && /Warming up/.test(e.text));
  assert.equal(notices.length, 1, "a wait the user can feel gets exactly one row");
  assert.equal(notices[0].scope, "gateway");
});

test("a thread's engine history is carried across before the resume, in both directions", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const { entry, meta } = await channel("C_RT_CARRY", "rt-carry");
  const cwd = resolveRuntime(entry.slug, meta).cwd;
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const claudeProjects = path.join(claudeEngineHome(), ".claude", "projects", key);

  // ── First message: the host. The row is stamped host, and the engine writes its transcript in
  // the daemon's own state dir (the stub engine does not, so it is planted here).
  useBackend(null);
  const first = await runMessage({ channelId: "C_RT_CARRY", authorId: "U_RT", text: "one", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });
  assert.equal((await getSessionRuntime(entry.slug, "9100.010")).backend, "host");
  await mkdir(path.join(claudeProjects, first.sessionId), { recursive: true });
  await writeFile(path.join(claudeProjects, `${first.sessionId}.jsonl`), "host transcript\n");
  await writeFile(path.join(claudeProjects, first.sessionId, "sub.jsonl"), "subagent\n");

  // ── Second message: the channel is now containerized. The session files must reach the container
  // BEFORE the engine is asked to resume, or the turn is healed and the history is gone.
  const backend = createFakeRuntimeBackend();
  useBackend(backend);
  await runMessage({ channelId: "C_RT_CARRY", authorId: "U_RT", text: "two", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });

  assert.equal(backend.calls.copyIn.length, 1, "exactly one carry, for the one thread that moved");
  assert.equal(backend.calls.copyOut.length, 0);
  assert.ok(backend.calls.copyIn[0].seq < backend.calls.spawn[0].seq, "the carry happens BEFORE the resume");
  const carried = backend.calls.copyIn[0].entries;
  assert.deepEqual(carried.map((e) => e.rel), [`projects/${key}/${first.sessionId}.jsonl`, `projects/${key}/${first.sessionId}`]);
  // It really arrived in the runtime's state dir, subagent transcripts included (the fake mirrors
  // the container's /home/agent tree under the artifact dir — see fakeContainerPath).
  const ctrTarget = fakeTarget(backend, entry.slug, meta);
  const ctrProjects = path.join(fakeContainerPath(ctrTarget, ctrTarget.container.claudeConfigDir), "projects", key);
  assert.equal(readFileSync(path.join(ctrProjects, `${first.sessionId}.jsonl`), "utf8"), "host transcript\n");
  assert.equal(readFileSync(path.join(ctrProjects, first.sessionId, "sub.jsonl"), "utf8"), "subagent\n");
  // The row now names the side holding the NEWEST copy. Without this a third container turn would
  // carry the stale host copy back over everything the second turn added.
  assert.equal((await getSessionRuntime(entry.slug, "9100.010")).backend, "container");
  // The event QA grades from says the backend change did not cost the thread its history.
  // readEvents is newest-first.
  const configs = readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === entry.slug);
  assert.equal(configs[0].sessionCarried, "host→container");
  assert.equal(configs[1].sessionCarried, undefined, "a turn that carried nothing records nothing");

  // ── Third message: back on the host (admin mode, a pin, the kill switch). The same thread's
  // history has to come back OUT of the container it was just written into.
  useBackend(null, {});
  setRuntimeResolver((slug, m, { backend: forced = "" } = {}) => (forced === "container" ? fakeTarget(backend, slug, m) : hostTarget(slug, m)));
  await runMessage({ channelId: "C_RT_CARRY", authorId: "U_RT", text: "three", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });
  assert.equal(backend.calls.copyOut.length, 1);
  assert.equal((await getSessionRuntime(entry.slug, "9100.010")).backend, "host");
  const back = readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === entry.slug)[0];
  assert.equal(back.sessionCarried, "container→host");
});

test("a carry that fails never fails the turn — the resume falls back to the existing heal", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const { entry, meta } = await channel("C_RT_CARRY_FAIL", "rt-carry-fail");
  const cwd = resolveRuntime(entry.slug, meta).cwd;
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");

  useBackend(null);
  const first = await runMessage({ channelId: "C_RT_CARRY_FAIL", authorId: "U_RT", text: "one", threadKey: "9100.011", origin: "slack_foreground", preferCold: true });
  await mkdir(path.join(claudeEngineHome(), ".claude", "projects", key), { recursive: true });
  await writeFile(path.join(claudeEngineHome(), ".claude", "projects", key, `${first.sessionId}.jsonl`), "host transcript\n");

  const backend = createFakeRuntimeBackend();
  backend.copyIn = async () => {
    throw new Error("no container CLI on PATH");
  };
  useBackend(backend);
  const result = await runMessage({ channelId: "C_RT_CARRY_FAIL", authorId: "U_RT", text: "two", threadKey: "9100.011", origin: "slack_foreground", preferCold: true });

  assert.match(result.content, /Stub engine reply/, "the turn still answers");
  const config = readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === entry.slug)[0];
  assert.equal(config.sessionCarried, undefined);
});

test("a slow carry announces itself before the turn's own warm-up notice is armed", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const { entry, meta } = await channel("C_RT_CARRY_SLOW", "rt-carry-slow");
  const key = resolveRuntime(entry.slug, meta).cwd.replace(/[^a-zA-Z0-9]/g, "-");

  useBackend(null);
  const first = await runMessage({ channelId: "C_RT_CARRY_SLOW", authorId: "U_RT", text: "one", threadKey: "9100.012", origin: "slack_foreground", preferCold: true });
  await mkdir(path.join(claudeEngineHome(), ".claude", "projects", key), { recursive: true });
  await writeFile(path.join(claudeEngineHome(), ".claude", "projects", key, `${first.sessionId}.jsonl`), "host transcript\n");

  const backend = createFakeRuntimeBackend();
  const realCopyIn = backend.copyIn;
  backend.copyIn = async (target, entries) => {
    // A cold container start inside the carry: seconds, with nothing else on screen yet.
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    return realCopyIn(target, entries);
  };
  useBackend(backend);
  const events = [];
  await runMessage({ channelId: "C_RT_CARRY_SLOW", authorId: "U_RT", text: "two", threadKey: "9100.012", origin: "slack_foreground", preferCold: true, onEvent: (e) => events.push(e) });

  const notices = events.filter((e) => e.kind === "notice" && /Bringing this thread's history across/.test(e.text));
  assert.equal(notices.length, 1, "a wait the user can feel gets exactly one row");
  assert.equal(notices[0].scope, "gateway");
});
