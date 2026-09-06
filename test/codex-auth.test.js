// Codex credential loss must be VISIBLE. The failure that motivated this file looked like this in
// Slack: a thread pinned to Codex, two turns, and nothing but "⏳ Working — 3m40s · starting"
// until the user pressed stop. Codex had lost its sign-in and, instead of exiting with an error
// the runner already knew how to classify, it stayed alive and said nothing — and a live process
// that says nothing is, correctly, never killed for being quiet.
//
// Three layers are covered here:
//   1. the pre-spawn credential gate (a container with no Codex sign-in never burns a turn at all),
//   2. live stderr classification (a credential lost mid-flight ends the turn in seconds),
//   3. the wedged path (chatter must not extend the silence budget, and the buffered stderr must
//      still be classified when it runs out).
// Layers 1 and 2 produce replay-safe `authentication` failures, which is what lets the
// orchestrator answer with the other harness instead of returning an opaque error.
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;

const { readCodexAuthState, codexAuthCandidates, describeCodexAuth, CODEX_LOGIN_HINT } = await import("../src/engines/codex-auth.js");
const { runCodex, classifyCodexLiveStderr, classifyCodexFailure, codexDiagnosticLine } = await import("../src/engines/codex.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");
const { credentialError: containerCredentialError } = await import("../src/runtimes/container/credentials.js");

// Every Codex turn runs in a channel container, so a direct runner call needs a container-shaped
// target. The fake backend delegates the spawn to this host (the stub `codex` on PATH really
// runs) and records whether a spawn happened at all.
const containerTarget = (backend = createFakeRuntimeBackend(), slug = "codex-auth") => fakeTarget(backend, slug, { platform: "slack", channelId: `C_${slug.toUpperCase().replace(/-/g, "_")}` });

const scratch = () => mkdtemp(path.join(os.tmpdir(), "cg-codex-auth-"));
const writeAuth = async (dir, contents) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
  return dir;
};
// The probe reads process.env by default; the daemon host may legitimately export a key.
const noEnvKey = { env: {} };

// ── 1. The probe ────────────────────────────────────────────────────────────────

test("an OPENAI_API_KEY in the daemon environment is a signed-in Codex", async () => {
  const state = await readCodexAuthState({ codexHome: "/nonexistent", env: { OPENAI_API_KEY: "sk-test" } });
  assert.equal(state.authenticated, true);
  assert.equal(state.method, "api-key");
  assert.equal(state.source, "env", "an env key needs no file to be read");
});

test("no auth.json anywhere is a positive 'signed out', naming both places it looked", async () => {
  const engineHome = path.join(await scratch(), ".codex");
  const hostHome = path.join(await scratch(), ".codex");
  const state = await readCodexAuthState({ codexHome: engineHome, hostCodexHome: hostHome, ...noEnvKey });
  assert.equal(state.known, true);
  assert.equal(state.authenticated, false);
  assert.match(state.detail, new RegExp(CODEX_LOGIN_HINT.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")));
  assert.match(state.detail, /auth\.json.* or .*auth\.json/, "both candidate paths belong in the message");
  assert.match(describeCodexAuth(state), /^Codex is not signed in/);
});

test("`codex logout` leaves a nulled-out file — that is signed out, not unreadable", async () => {
  const home = await writeAuth(path.join(await scratch(), ".codex"), { OPENAI_API_KEY: null, tokens: null });
  const state = await readCodexAuthState({ codexHome: home, ...noEnvKey });
  assert.equal(state.known, true);
  assert.equal(state.authenticated, false);
});

test("an empty tokens object is signed out; a refresh token is signed in", async () => {
  const empty = await writeAuth(path.join(await scratch(), ".codex"), { tokens: {} });
  assert.equal((await readCodexAuthState({ codexHome: empty, ...noEnvKey })).authenticated, false);

  const signedIn = await writeAuth(path.join(await scratch(), ".codex"), { tokens: { refresh_token: "rt", access_token: "" } });
  const state = await readCodexAuthState({ codexHome: signedIn, ...noEnvKey });
  assert.equal(state.authenticated, true);
  assert.equal(state.method, "chatgpt");
});

test("an expired ACCESS token is not evidence of a signed-out host", async () => {
  // The access token a ChatGPT sign-in mints expires hourly and is refreshed automatically. If the
  // probe treated that as logged out it would divert every channel on the host, permanently.
  const home = await writeAuth(path.join(await scratch(), ".codex"), {
    tokens: { access_token: "expired-but-refreshable", refresh_token: "rt" },
    last_refresh: "2001-01-01T00:00:00.000Z",
  });
  assert.equal((await readCodexAuthState({ codexHome: home, ...noEnvKey })).authenticated, true);
});

test("an unreadable or unfamiliar credential file fails OPEN, never blocking a run", async () => {
  const broken = await writeAuth(path.join(await scratch(), ".codex"), "{not json");
  const brokenState = await readCodexAuthState({ codexHome: broken, ...noEnvKey });
  assert.equal(brokenState.known, false);
  assert.equal(brokenState.authenticated, false, "unknown is not authenticated — but it is also not a refusal");

  const alien = await writeAuth(path.join(await scratch(), ".codex"), { something_else: true });
  assert.equal((await readCodexAuthState({ codexHome: alien, ...noEnvKey })).known, false);
});

test("the engine home is consulted first, the host state dir second", async () => {
  const engineHome = await writeAuth(path.join(await scratch(), ".codex"), { tokens: { refresh_token: "engine" } });
  const hostHome = await writeAuth(path.join(await scratch(), ".codex"), { OPENAI_API_KEY: "sk-host" });

  const both = await readCodexAuthState({ codexHome: engineHome, hostCodexHome: hostHome, ...noEnvKey });
  assert.equal(both.method, "chatgpt", "the home Codex actually spawns with wins");

  // Before the first Codex run plants the symlink the engine home is empty — the host credential
  // that is about to be linked in must still count, or a fresh install reads as signed out.
  const hostOnly = await readCodexAuthState({ codexHome: path.join(await scratch(), ".codex"), hostCodexHome: hostHome, ...noEnvKey });
  assert.equal(hostOnly.authenticated, true);
  assert.equal(hostOnly.method, "api-key");

  const candidates = codexAuthCandidates({ codexHome: engineHome, hostCodexHome: hostHome, env: {} });
  assert.deepEqual(candidates, [path.join(engineHome, "auth.json"), path.join(hostHome, "auth.json")]);
});

// ── 2. The runner ───────────────────────────────────────────────────────────────

test("a missing host Codex login does not suppress the channel's independent native login", async () => {
  const empty = path.join(await scratch(), ".codex");
  const backend = createFakeRuntimeBackend({ credentialError: (target, engine) => containerCredentialError(target, engine, { CODEX_HOME: empty }) });
  const target = containerTarget(backend, "codex-auth-independent");
  await runCodex({ cwd: fixtureBin, prompt: "hello", sessionId: "", isNewSession: true, target, artifactDir: target.artifactDir, timeoutMs: 5_000 });
  assert.equal(backend.calls.spawn.length, 1);
  const unknown = await readCodexAuthState({ daemonOnly: true, env: {}, readFileImpl: () => assert.fail("no host credential should be read") });
  assert.equal(unknown.known, false);
});

test("a credential lost MID-FLIGHT ends the turn in seconds instead of heartbeating", async () => {
  // The stub prints Codex's own logged-out line on stderr and then waits forever, which is what
  // the incident looked like. The inactivity window here is a minute: if the turn only ended
  // because of the watchdog, this test would take one.
  const startedAt = Date.now();
  const notes = [];
  const target = containerTarget();
  await assert.rejects(
    runCodex({
      cwd: fixtureBin,
      prompt: "CODEX_STUB_AUTH_HANG",
      sessionId: "",
      isNewSession: true,
      timeoutMs: 60_000,
      maxSilenceMs: 60_000,
      onEvent: (e) => notes.push(e),
      target,
      artifactDir: target.artifactDir,
    }),
    (error) => {
      assert.match(error.message, /Codex authentication failed/i);
      assert.equal(error.details?.providerKind, "authentication");
      assert.equal(error.details?.replaySafe, true, "nothing ran, so the turn may be answered by the other harness");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 20_000, "the failure must not wait for the inactivity window");
  assert.ok(
    notes.some((e) => e.kind === "engine_note" && /not logged in/i.test(e.text)),
    "the user's status row must be told what the turn is stuck on",
  );
});

test("the same line AFTER a tool ran neither ends the turn early nor makes it replayable", async () => {
  // A turn that already touched a tool may have mutated something. It still fails — via the
  // silence budget — but it must never be replayed on the other harness.
  const target = containerTarget();
  await assert.rejects(
    runCodex({
      cwd: fixtureBin,
      prompt: "CODEX_STUB_AUTH_AFTER_TOOL",
      sessionId: "",
      isNewSession: true,
      timeoutMs: 400,
      maxSilenceMs: 800,
      target,
      artifactDir: target.artifactDir,
    }),
    (error) => {
      assert.equal(error.details?.providerKind, "authentication", "the reason is still named");
      assert.equal(error.details?.replaySafe, false, "a tool ran — never replay");
      assert.ok(error.details?.toolUseCount >= 1);
      return true;
    },
  );
});

// ── 3. The wedged path ──────────────────────────────────────────────────────────

test("stderr chatter does not extend the silence budget, and the wedge is classified", async () => {
  // Retry logging used to count as activity, so a process retrying a 401 forever could never
  // exhaust its budget: an immortal turn that produced nothing. Now progress means stdout, and
  // when the budget does run out the buffered stderr still names the cause.
  const startedAt = Date.now();
  const target = containerTarget();
  await assert.rejects(
    runCodex({
      cwd: fixtureBin,
      prompt: "CODEX_STUB_STALL_401",
      sessionId: "",
      isNewSession: true,
      timeoutMs: 300,
      maxSilenceMs: 900,
      target,
      artifactDir: target.artifactDir,
    }),
    (error) => {
      assert.equal(error.details?.providerKind, "authentication", "a wedged turn is not an opaque one");
      assert.equal(error.details?.replaySafe, true);
      assert.match(error.message, /no output for/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 15_000, "a chatty process must still exhaust its silence budget");
});

// ── Classification boundaries ───────────────────────────────────────────────────

test("only Codex's own sign-in phrasing ends a live turn", async () => {
  for (const line of [
    "ERROR: not logged in. Run `codex login` to authenticate.",
    "auth token expired, please sign in again",
    "token refresh failed",
    "Your refresh token is invalid",
  ]) {
    assert.equal(classifyCodexLiveStderr(line), "authentication", `should classify: ${line}`);
  }
  for (const line of [
    "mcp server composio: request failed with 401 Unauthorized",
    "stream error: unexpected status 401 Unauthorized; retrying 1/5 in 200ms",
    "warning: could not read config",
    "the user asked about an expired invoice",
  ]) {
    assert.equal(classifyCodexLiveStderr(line), "", `must NOT end a live turn: ${line}`);
  }
  // The post-mortem classifier stays broad on purpose — it only ever runs on a dead process.
  assert.equal(classifyCodexFailure({ message: "request failed: 401 Unauthorized" }), "authentication");
});

test("a diagnostic line reaches the user short, useful, and free of credentials", async () => {
  const noisy = [
    "2026-08-24T21:02:10Z DEBUG spawning subprocess",
    "stream error: unexpected status 401 Unauthorized; retrying 1/5 in 200ms",
  ].join("\n");
  assert.equal(codexDiagnosticLine(noisy), "stream error: unexpected status 401 Unauthorized; retrying 1/5 in 200ms");

  const leaky = "auth failed for Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const shown = codexDiagnosticLine(leaky);
  assert.doesNotMatch(shown, /eyJzdWIi/, "a token echoed into stderr must never reach Slack");
  assert.match(shown, /\[REDACTED\]/);
  assert.ok(codexDiagnosticLine("x".repeat(500)).length <= 200, "status rows are capped");
});
