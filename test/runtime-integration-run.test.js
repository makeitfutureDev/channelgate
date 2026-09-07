// The turn half of the container runtime: what runMessage does with the RuntimeTarget it resolves
// once per turn. Driven end-to-end through a FAKE backend (test/runtime-fake.js) so the ordering
// guarantees are observed rather than inferred — the real backend needs docker, an image and a
// permissive kernel, none of which a test suite may require.
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
const { getSessionRuntime, getSession, getSessionEngine, saveSession } = await import("../src/gateway/sessions.js");
const { readEvents } = await import("../src/util/logger.js");
const { runTmpDir, claudeEngineHome } = await import("../src/config/paths.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { createFakeRuntimeBackend, fakeContainerPath, fakeTarget, FAKE_IMAGE } = await import("./runtime-fake.js");

async function channel(id, name, meta = {}) {
  await setUser("U_RT", { name: "Runtime User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const full = { channelId: id, name, type: "channel", template: "custom", engine: "claude", allowedMcps: [], platform: "slack", ...meta };
  await saveChannelMeta(entry.slug, full);
  await mkdir(resolveRuntime(entry.slug, full).cwd, { recursive: true });
  return { entry, meta: full };
}

// Route every turn in a test through `backend`, with the real resolver supplying the paths.
function useBackend(backend, { record = null } = {}) {
  setRuntimeResolver((slug, meta) => {
    record?.push(meta);
    return fakeTarget(backend, slug, meta);
  });
}

// A thread that last ran on the HOST — what every session row from before the container runtime
// looks like, and the one case the carry-over exists for. There is no host backend to run the
// first turn on any more, so the row is put into that state directly: the first turn runs through
// a fake container (the only backend there is), its row is then re-stamped the way the host
// backend used to write it, and the transcript is planted where a host turn's engine wrote it —
// the daemon's own engine state dir.
async function hostThread(channelId, threadKey, { entry, meta }) {
  useBackend(createFakeRuntimeBackend());
  const first = await runMessage({ channelId, authorId: "U_RT", text: "one", threadKey, origin: "slack_foreground", preferCold: true });
  await saveSession(entry.slug, threadKey, first.sessionId, "claude", null, JSON.stringify({ backend: "host", fingerprint: "host", image: "" }));
  assert.equal((await getSessionRuntime(entry.slug, threadKey)).backend, "host");
  const key = resolveRuntime(entry.slug, meta).cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = path.join(claudeEngineHome(), ".claude", "projects", key);
  await mkdir(path.join(projects, first.sessionId), { recursive: true });
  await writeFile(path.join(projects, `${first.sessionId}.jsonl`), "host transcript\n");
  await writeFile(path.join(projects, first.sessionId, "sub.jsonl"), "subagent\n");
  return { sessionId: first.sessionId, key };
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

test("a Claude turn relays the OPERATOR's login into the container — never a stale engine-home copy", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
  const backend = createFakeRuntimeBackend();
  useBackend(backend);
  await channel("C_RT_RELAYLOGIN", "rt-relay-login");

  await runMessage({ channelId: "C_RT_RELAYLOGIN", authorId: "U_RT", text: "hello", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });

  const spawned = backend.calls.spawn.at(-1);
  assert.equal(spawned.cmd, "claude");
  // The whole point: the engine-home file seeded above is hard-expired, the operator's is valid,
  // and the child is handed the OPERATOR's access token rather than being left to read a dead copy.
  assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, OPERATOR_RELAY_TOKEN);
  assert.ok(!spawned.env.CLAUDE_CODE_OAUTH_TOKEN.includes("stale-engine-home"));
  // …and the child's config dir is the IMAGE's, never the daemon's synthetic engine home (which
  // is not mounted, and whose credentials copy is exactly the dead one above).
  assert.equal(spawned.env.CLAUDE_CONFIG_DIR, "/home/agent/.claude");
  assert.ok(!spawned.env.CLAUDE_CONFIG_DIR.startsWith(claudeEngineHome()));
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
  // The row resolveSession minted for this brand-new thread carried a "claude" stamp before
  // anything ran. It must not survive a turn that never started: otherwise the next message would
  // "continue on claude" — and fail the same way — even after the channel moved to Codex (live,
  // 2026-09-05). Deleted, not tombstoned: the thread is a first turn again.
  assert.equal(await getSession("rt-nocred", "9100.003"), null, "the minted row is dropped with the failed turn");
});

test("a thread whose first turn never started follows the channel's harness on its next message", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: false, codexEnabled: true });
  const message = "This channel runs in a container, but no Claude token is configured.";
  const backend = createFakeRuntimeBackend({ credentialError: (target, engine) => (engine === "claude" ? message : "") });
  useBackend(backend);
  const { entry, meta } = await channel("C_RT_NOCRED2", "rt-nocred2");
  await assert.rejects(
    runMessage({ channelId: "C_RT_NOCRED2", authorId: "U_RT", text: "hello", threadKey: "9100.004", origin: "slack_foreground", preferCold: true }),
    /no Claude token is configured/,
  );
  assert.equal(await getSession(entry.slug, "9100.004"), null);

  // The operator moves the channel to Codex. The SAME thread now runs on Codex — no "this thread
  // started on claude" continuation, because no claude session ever existed.
  await saveChannelMeta(entry.slug, { ...meta, engine: "codex" });
  const result = await runMessage({ channelId: "C_RT_NOCRED2", authorId: "U_RT", text: "hello again", threadKey: "9100.004", origin: "slack_foreground", preferCold: true });
  assert.equal(result.engine, "codex");
  assert.equal(await getSession(entry.slug, "9100.004"), result.sessionId);
  assert.equal(await getSessionEngine(entry.slug, "9100.004"), "codex", "the thread's session belongs to the harness that actually ran");
  assert.equal(backend.calls.spawn.length, 1);
});

test("an EXISTING thread keeps its session when a later turn fails before the engine starts", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal", engineFallback: false, codexEnabled: true });
  const backend = createFakeRuntimeBackend({ credentialError: (target, engine) => (engine === "claude" && backend.deny ? "This channel runs in a container, but no Claude token is configured." : "") });
  useBackend(backend);
  const { entry } = await channel("C_RT_NOCRED3", "rt-nocred3");
  // A real first turn on Claude...
  const first = await runMessage({ channelId: "C_RT_NOCRED3", authorId: "U_RT", text: "one", threadKey: "9100.005", origin: "slack_foreground", preferCold: true });
  assert.equal(await getSession(entry.slug, "9100.005"), first.sessionId);
  assert.equal(await getSessionEngine(entry.slug, "9100.005"), "claude");
  // ...then the login disappears. The turn fails closed, and the thread's session — the engine's
  // history — is exactly as it was: only a row minted by the failed turn itself is ever dropped.
  backend.deny = true;
  await assert.rejects(
    runMessage({ channelId: "C_RT_NOCRED3", authorId: "U_RT", text: "two", threadKey: "9100.005", origin: "slack_foreground", preferCold: true }),
    /no Claude token is configured/,
  );
  assert.equal(await getSession(entry.slug, "9100.005"), first.sessionId, "an existing session survives a pre-spawn failure");
  assert.equal(await getSessionEngine(entry.slug, "9100.005"), "claude");
});

test("the per-run MCP config lands under the artifact dir; only the daemon's own turns keep run-tmp", () => {
  const backend = createFakeRuntimeBackend();
  const isolated = fakeTarget(backend, "rt-mcp", { platform: "slack" });
  assert.equal(runArtifactRoot(isolated), isolated.artifactDir);
  assert.notEqual(runArtifactRoot(isolated), runTmpDir());
  // The daemon's own probes (the updater's smoke test) pass no target, or its local one, and mount
  // nothing — they keep today's location under the gateway root.
  assert.equal(runArtifactRoot(null), runTmpDir(), "a caller with no target keeps today's location");
  assert.equal(runArtifactRoot(localRuntimeTarget(process.cwd())), runTmpDir());
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
  // There is exactly one backend, and the record says so rather than pretending a choice was made.
  assert.equal(config.runtimeReason, "only-runtime");
  // The compiled network policy is what the engine was TOLD, never a boundary anything applied:
  // the container is on the bridge network and no egress is policed per channel. Recorded next to
  // the mode so an operator reading the event after an incident cannot mistake `"off"` for "this
  // turn could not reach the internet".
  assert.equal(config.networkPolicy, "off");
  assert.equal(config.networkEnforced, false);
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

test("a thread that last ran on the host has its engine history carried in before the resume", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const ch = await channel("C_RT_CARRY", "rt-carry");
  const { entry, meta } = ch;

  // ── First message: a host row, with the engine's transcript in the daemon's own state dir.
  const { sessionId, key } = await hostThread("C_RT_CARRY", "9100.010", ch);

  // ── Second message: the channel's container. The session files must reach it BEFORE the engine
  // is asked to resume, or the turn is healed and the history is gone.
  const backend = createFakeRuntimeBackend();
  useBackend(backend);
  await runMessage({ channelId: "C_RT_CARRY", authorId: "U_RT", text: "two", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });

  assert.equal(backend.calls.copyIn.length, 1, "exactly one carry, for the one thread that moved");
  assert.equal(backend.calls.copyOut.length, 0, "there is no host to carry anything OUT to");
  assert.ok(backend.calls.copyIn[0].seq < backend.calls.spawn[0].seq, "the carry happens BEFORE the resume");
  const carried = backend.calls.copyIn[0].entries;
  assert.deepEqual(carried.map((e) => e.rel), [`projects/${key}/${sessionId}.jsonl`, `projects/${key}/${sessionId}`]);
  // It really arrived in the runtime's state dir, subagent transcripts included (the fake mirrors
  // the container's /home/agent tree under the artifact dir — see fakeContainerPath).
  const ctrTarget = fakeTarget(backend, entry.slug, meta);
  const ctrProjects = path.join(fakeContainerPath(ctrTarget, ctrTarget.container.claudeConfigDir), "projects", key);
  assert.equal(readFileSync(path.join(ctrProjects, `${sessionId}.jsonl`), "utf8"), "host transcript\n");
  assert.equal(readFileSync(path.join(ctrProjects, sessionId, "sub.jsonl"), "utf8"), "subagent\n");
  // The row now names the side holding the NEWEST copy. Without this a third container turn would
  // carry the stale host copy back over everything the second turn added.
  assert.equal((await getSessionRuntime(entry.slug, "9100.010")).backend, "container");
  // The event QA grades from says the backend change did not cost the thread its history.
  // readEvents is newest-first.
  const configs = readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === entry.slug);
  assert.equal(configs[0].sessionCarried, "host→container");
  assert.equal(configs[1].sessionCarried, undefined, "a turn that carried nothing records nothing");

  // ── Third message: still the container. The row says so, so nothing is copied again — the
  // stale host copy must never be carried back over what the second turn added.
  await runMessage({ channelId: "C_RT_CARRY", authorId: "U_RT", text: "three", threadKey: "9100.010", origin: "slack_foreground", preferCold: true });
  assert.equal(backend.calls.copyIn.length, 1);
  assert.equal(backend.calls.copyOut.length, 0);
  assert.equal(readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === entry.slug)[0].sessionCarried, undefined);
});

test("a carry that fails never fails the turn — the resume falls back to the existing heal", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const ch = await channel("C_RT_CARRY_FAIL", "rt-carry-fail");
  await hostThread("C_RT_CARRY_FAIL", "9100.011", ch);

  const backend = createFakeRuntimeBackend();
  backend.copyIn = async () => {
    throw new Error("no container CLI on PATH");
  };
  useBackend(backend);
  const result = await runMessage({ channelId: "C_RT_CARRY_FAIL", authorId: "U_RT", text: "two", threadKey: "9100.011", origin: "slack_foreground", preferCold: true });

  assert.match(result.content, /Stub engine reply/, "the turn still answers");
  const config = readEvents({ limit: 200 }).filter((e) => e.event === "run_config" && e.slug === ch.entry.slug)[0];
  assert.equal(config.sessionCarried, undefined);
});

test("a slow carry announces itself before the turn's own warm-up notice is armed", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const ch = await channel("C_RT_CARRY_SLOW", "rt-carry-slow");
  await hostThread("C_RT_CARRY_SLOW", "9100.012", ch);

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
