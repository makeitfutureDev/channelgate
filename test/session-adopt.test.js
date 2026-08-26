// `/resume <command or id>` — adopting an existing local engine session into a Slack thread.
// The security property under test is the same-channel rule: a session may only be adopted in the
// channel whose own working folder produced it, judged by the transcript's recorded cwd (never by
// the `cd` the user pasted), and never when the id is already bound to another thread.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const adopt = await import("../src/gateway/session-adopt.js");
const { saveSession, clearSession } = await import("../src/gateway/sessions.js");

const SESSION = "df94f2c6-4a6d-43b3-b464-8c6009d912c5";
const CHANNEL_DIR = mkdtempSync(path.join(os.tmpdir(), "cg-adopt-work-"));
const OTHER_DIR = mkdtempSync(path.join(os.tmpdir(), "cg-adopt-other-"));
const STATE = mkdtempSync(path.join(os.tmpdir(), "cg-adopt-state-"));

// A minimal Claude transcript: the store is `projects/<encoded-cwd>/<session-id>.jsonl`, and each
// record carries the cwd the session was started in.
function writeClaudeSession(sessionId, cwd, { recordCwd = true } = {}) {
  const dir = path.join(STATE, "projects", adopt.claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: "user", sessionId, ...(recordCwd ? { cwd } : {}), message: { role: "user", content: "hi" } });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${line}\n`);
}

const plan = (arg, over = {}) =>
  adopt.planSessionAdoption({
    arg,
    slug: "acme",
    threadKey: "1700000000.000100",
    workDir: CHANNEL_DIR,
    threadEngine: "claude",
    dirs: { claude: STATE, codex: path.join(STATE, "codex") },
    ...over,
  });

test("a pasted resume command survives Slack escaping, smart quotes, and backticks", () => {
  const parsed = adopt.parseResumeRequest('cd “/home/dev/Projects Customers/Acme” &amp;&amp; claude --resume ' + SESSION);
  assert.deepEqual(parsed, { sessionId: SESSION, cwd: "/home/dev/Projects Customers/Acme", engine: "claude" });
  assert.deepEqual(adopt.parseResumeRequest("`claude -r " + SESSION + "`"), { sessionId: SESSION, cwd: "", engine: "claude" });
  assert.deepEqual(adopt.parseResumeRequest(` ${SESSION} `), { sessionId: SESSION, cwd: "", engine: "" });
  assert.deepEqual(adopt.parseResumeRequest("cd /srv/app && codex exec resume abc12345"), { sessionId: "abc12345", cwd: "/srv/app", engine: "codex" });
});

test("nonsense arguments never produce a session id", () => {
  assert.equal(adopt.parseResumeRequest(""), null);
  assert.equal(adopt.parseResumeRequest("the session from yesterday please"), null);
  assert.equal(adopt.parseResumeRequest("claude --resume"), null);
  assert.equal(adopt.parseResumeRequest("../../etc/passwd"), null);
});

test("a session started in this channel's folder is adopted into the thread", async () => {
  writeClaudeSession(SESSION, CHANNEL_DIR);
  const result = await plan(`cd "${CHANNEL_DIR}" &amp;&amp; claude --resume ${SESSION}`);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, SESSION);
  assert.equal(result.engine, "claude");
  assert.equal(result.cwd, CHANNEL_DIR);
  assert.match(result.message, /continues Claude session/);
});

test("a session from another channel's folder is refused, whatever the pasted cd claims", async () => {
  const foreign = "aaaaaaaa-1111-2222-3333-444444444444";
  writeClaudeSession(foreign, OTHER_DIR);
  const honest = await plan(`cd "${OTHER_DIR}" && claude --resume ${foreign}`);
  assert.equal(honest.ok, false);
  assert.match(honest.message, /only be resumed in the channel that owns its folder/);
  // Lying about the cwd must not launder the session into this channel — the transcript's own
  // recorded cwd decides.
  const lying = await plan(`cd "${CHANNEL_DIR}" && claude --resume ${foreign}`);
  assert.equal(lying.ok, false);
  assert.match(lying.message, /only be resumed in the channel that owns its folder/);
});

test("a cd that disagrees with this channel's folder is refused even for its own session", async () => {
  writeClaudeSession(SESSION, CHANNEL_DIR);
  const result = await plan(`cd "${OTHER_DIR}" && claude --resume ${SESSION}`);
  assert.equal(result.ok, false);
  assert.match(result.message, /isn't this channel's folder/);
});

test("a folder whose name Slack re-spaced still matches its own channel", async () => {
  // Slack's slash-command parsing collapses runs of whitespace, so a double-spaced folder name
  // survives the paste in collapsed form. The session is still this channel's.
  const spaced = path.join(mkdtempSync(path.join(os.tmpdir(), "cg-adopt-space-")), "Projects  Customers");
  mkdirSync(spaced, { recursive: true });
  const id = "eeeeeeee-1111-2222-3333-888888888888";
  writeClaudeSession(id, spaced);
  const result = await plan(`cd "${spaced.replace(/\s+/g, " ")}" && claude --resume ${id}`, { workDir: spaced });
  assert.equal(result.ok, true);
});

test("an unknown session id is refused rather than bound blindly", async () => {
  const result = await plan("claude --resume bbbbbbbb-1111-2222-3333-555555555555");
  assert.equal(result.ok, false);
  assert.match(result.message, /can't find Claude session/);
});

test("a session already bound to another thread cannot be adopted twice", async () => {
  writeClaudeSession(SESSION, CHANNEL_DIR);
  await saveSession("otherchannel", "1700000000.000999", SESSION, "claude");
  const crossChannel = await plan(`claude --resume ${SESSION}`);
  assert.equal(crossChannel.ok, false);
  assert.match(crossChannel.message, /another channel's thread/);
  await clearSession("otherchannel", "1700000000.000999");

  await saveSession("acme", "1700000000.000777", SESSION, "claude");
  const sameChannel = await plan(`claude --resume ${SESSION}`);
  assert.equal(sameChannel.ok, false);
  assert.match(sameChannel.message, /another thread in this channel/);
  await clearSession("acme", "1700000000.000777");
});

test("re-adopting the thread's current session is a no-op with an explanation", async () => {
  writeClaudeSession(SESSION, CHANNEL_DIR);
  const result = await plan(`claude --resume ${SESSION}`, { currentSessionId: SESSION });
  assert.equal(result.ok, false);
  assert.match(result.message, /already continuing session/);
});

test("a transcript with no recorded cwd falls back to the encoded project directory", async () => {
  const legacy = "cccccccc-1111-2222-3333-666666666666";
  writeClaudeSession(legacy, CHANNEL_DIR, { recordCwd: false });
  const ours = await plan(`claude --resume ${legacy}`);
  assert.equal(ours.ok, true);

  const legacyForeign = "dddddddd-1111-2222-3333-777777777777";
  writeClaudeSession(legacyForeign, OTHER_DIR, { recordCwd: false });
  const theirs = await plan(`claude --resume ${legacyForeign}`);
  assert.equal(theirs.ok, false);
});

test("a bare id is looked up in every adoptable store, not just the thread's engine", async () => {
  // Claude and Codex both mint uuids, so the thread's engine is only a first guess for a pasted
  // bare id. This Codex rollout must be found from a Claude thread — and adopted AS Codex.
  const id = "ffffffff-1111-2222-3333-999999999999";
  const dir = path.join(STATE, "codex", "sessions", "2026", "08", "22");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `rollout-2026-08-22T09-00-00-${id}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: CHANNEL_DIR } })}\n`
  );
  const result = await plan(id);
  assert.equal(result.ok, true);
  assert.equal(result.engine, "codex");
  assert.match(result.message, /continues Codex session/);
});

test("engines without a verifiable local transcript are refused explicitly", async () => {
  const result = await plan("opencode run --session ses_abcdefgh");
  assert.equal(result.ok, false);
  assert.match(result.message, /can't be adopted/);
});
