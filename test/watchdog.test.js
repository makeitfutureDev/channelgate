import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createStallWatchdog, pidAlive, describeSilence } = await import("../src/engines/watchdog.js");

// The behaviour this module exists to change: silence used to mean death. A CLI is a thin client,
// so while the model thinks server-side — or the provider hands back a rate limit and the CLI
// backs off — it legitimately emits nothing and burns no CPU. Killing there destroys working
// turns. Quiet now reports and keeps waiting; only a vanished process or an exhausted absolute
// silence budget ends the turn.

function harness({ alive = true, timeoutMs = 1000, maxSilenceMs = 3000 } = {}) {
  const quiet = [];
  const kills = [];
  let clock = 0;
  let liveness = alive;
  const wd = createStallWatchdog({
    timeoutMs,
    maxSilenceMs,
    isAlive: () => liveness,
    onQuiet: (info) => quiet.push(info),
    onKill: (info) => kills.push(info),
    now: () => clock,
  });
  return {
    wd,
    quiet,
    kills,
    setAlive: (v) => (liveness = v),
    advance: (ms) => (clock += ms),
  };
}

// The timers are real, so drive them by awaiting slightly longer than the window.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test("a quiet but living turn is reported, never killed", async () => {
  const h = harness({ timeoutMs: 30, maxSilenceMs: 10_000 });
  h.advance(30);
  await settle(60);

  assert.equal(h.kills.length, 0, "a living process must not be killed for being quiet");
  assert.ok(h.quiet.length >= 1, "the wait must be reported so the user sees it");
  assert.equal(h.quiet[0].willKeepWaiting, true);
  assert.ok(h.quiet[0].silentMs >= 30);
  h.wd.stop();
});

test("quiet is reported repeatedly, so the status keeps advancing", async () => {
  const h = harness({ timeoutMs: 20, maxSilenceMs: 10_000 });
  h.advance(20);
  await settle(30);
  h.advance(20);
  await settle(30);

  assert.ok(h.quiet.length >= 2, "each window should report again rather than going silent itself");
  assert.ok(h.quiet.at(-1).silentMs > h.quiet[0].silentMs, "reported silence must grow");
  h.wd.stop();
});

test("a vanished process ends the turn immediately, without waiting out the budget", async () => {
  const h = harness({ timeoutMs: 20, maxSilenceMs: 10_000 });
  h.setAlive(false);
  h.advance(20);
  await settle(40);

  assert.equal(h.kills.length, 1);
  assert.equal(h.kills[0].reason, "process-gone");
  assert.equal(h.quiet.length, 0, "a dead process is not a quiet one");
  h.wd.stop();
});

test("an exhausted silence budget still ends a wedged turn", async () => {
  const h = harness({ timeoutMs: 20, maxSilenceMs: 40 });
  h.advance(20);
  await settle(30); // first window: quiet, keep waiting
  h.advance(30); // now past the budget
  await settle(30);

  assert.equal(h.kills.length, 1, "the turn must not hang forever");
  assert.equal(h.kills[0].reason, "silence-budget");
  assert.ok(h.kills[0].silentMs >= 40);
  h.wd.stop();
});

test("activity resets the clock, so a busy turn runs as long as it needs", async () => {
  const h = harness({ timeoutMs: 30, maxSilenceMs: 60 });
  // Keep touching across a span that would otherwise blow the whole budget.
  for (let i = 0; i < 4; i++) {
    h.advance(20);
    h.wd.touch();
    await settle(10);
  }
  assert.equal(h.kills.length, 0, "output means progress — total runtime is never capped");
  h.wd.stop();
});

test("stop() ends reporting for a finished turn", async () => {
  const h = harness({ timeoutMs: 20, maxSilenceMs: 10_000 });
  h.wd.stop();
  h.advance(100);
  await settle(40);
  assert.equal(h.quiet.length, 0);
  assert.equal(h.kills.length, 0);
});

test("pidAlive recognizes this process and rejects a pid that cannot exist", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(null), false);
});

test("describeSilence renders windows a human can read", () => {
  assert.equal(describeSilence(45_000), "45s");
  assert.equal(describeSilence(9 * 60_000), "9m");
  assert.equal(describeSilence(75 * 60_000), "1h15m");
});

test("every engine runner reports stderr as LIVENESS — never as progress", async () => {
  // A CLI that backs off from a provider 429 may log only to stderr, and that must never be
  // mistaken for a dead process. It must also never be mistaken for PROGRESS: a runner that
  // re-armed the silence budget on every retry line kept wedged turns alive forever (the Codex
  // signed-out hang). Both halves of that contract are asserted here, on every runner.
  const { readFile } = await import("node:fs/promises");
  for (const runner of ["claude.js", "codex.js", "opencode.js", "persistent-session.js"]) {
    const src = await readFile(new URL(`../src/engines/${runner}`, import.meta.url), "utf8");
    // Structural, not length-capped: take each handler from its `stderr.on("data",` to the first
    // line that closes it, so a handler growing a body never silently drops out of this check.
    const stderrHandlers = src
      .split(/(?:child|this\.child)\.stderr\.on\("data",/)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("\n    });")));
    assert.ok(stderrHandlers.length > 0, `${runner} has a stderr handler`);
    for (const handler of stderrHandlers) {
      assert.match(handler, /touchLiveness|noteLiveness\(\)/, `${runner} stderr handler records liveness`);
      assert.doesNotMatch(handler, /watchdog\.touch\(\)|armKillTimer\(\)|turn\?\.touch\?\.\(\)/, `${runner} stderr must not count as progress`);
    }
  }
});

test("liveness keeps the process honest without buying the turn more time", () => {
  // The wedge this exists to end: stderr chatter used to reset the budget, so a process that
  // logged a failing retry every second could never be declared wedged.
  const h = harness({ timeoutMs: 1000, maxSilenceMs: 3000 });
  h.advance(900);
  h.wd.touchLiveness();
  h.advance(100);
  assert.equal(h.wd.silentMs(), 1000, "a liveness signal is not progress");
  assert.equal(h.wd.livenessMs(), 100, "…but it is remembered");
  h.wd.touch();
  assert.equal(h.wd.silentMs(), 0, "progress still resets the clock");
  h.wd.stop();
});

test("a chatty but wedged process still exhausts its silence budget", async () => {
  const h = harness({ timeoutMs: 20, maxSilenceMs: 40 });
  h.wd.touchLiveness();
  h.advance(20);
  await settle(30);
  h.wd.touchLiveness();
  h.advance(30);
  await settle(30);

  assert.equal(h.kills.length, 1, "liveness must not postpone the budget forever");
  assert.equal(h.kills[0].reason, "silence-budget");
  assert.ok(h.kills[0].livenessMs !== null, "the report says the engine was still talking");
});
