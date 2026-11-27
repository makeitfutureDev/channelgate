// `/resume <command or id>` — adopting an existing local engine session into a Slack thread.
// The security property under test is the same-channel rule: a session may only be adopted in the
// channel whose own working folder produced it, judged by the transcript's recorded cwd (never by
// the `cd` the user pasted), and never when the id is already bound to another thread.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const adopt = await import("../src/gateway/session-adopt.js");
const { saveSession, clearSession } = await import("../src/gateway/sessions.js");
const { expandCarryEntry } = await import("../src/runtimes/copy.js");

const SESSION = "df94f2c6-4a6d-43b3-b464-8c6009d912c5";
const CHANNEL_DIR = tempDir("cg-adopt-work-");
const OTHER_DIR = tempDir("cg-adopt-other-");
const STATE = tempDir("cg-adopt-state-");

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

// ── The container runtime ─────────────────────────────────────────────────────────────────────
// Under containers-only a thread's transcripts live in the channel's HOME volume, never in the
// daemon's engine dirs, so a lookup that only reads the host finds nothing — which is exactly how
// adoption came to be impossible for every channel. The fixture below is that volume: one scratch
// directory, reached BOTH ways the gateway can reach it — read straight off the host where the
// volume is traversable, and asked of the container (the usual rootless case, where it is not).
const CONTAINER_HOME = "/home/agent";

function writeContainerClaudeSession(volumeDir, sessionId, cwd) {
  const dir = path.join(volumeDir, ".claude", "projects", adopt.claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", sessionId, cwd, message: { role: "user", content: "hi" } })}\n`);
}

function writeContainerCodexSession(volumeDir, sessionId, cwd) {
  const dir = path.join(volumeDir, ".codex", "sessions", "2026", "09", "06");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `rollout-2026-09-06T21-13-00-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`);
}

// `readableVolume` is the difference between the two routes: with it the daemon reads the volume's
// data dir itself, without it the only way in is the runtime's read-only inspectState().
function containerTarget(volumeDir, { readableVolume = false } = {}) {
  const asked = [];
  return {
    asked,
    container: {
      name: "cg-test-slack-acme",
      home: CONTAINER_HOME,
      claudeConfigDir: `${CONTAINER_HOME}/.claude`,
      codexHome: `${CONTAINER_HOME}/.codex`,
      homeVolumeHostPath: readableVolume ? volumeDir : "",
    },
    runtime: {
      // Stands in for one `sh -c` in the container: expand the glob inside, answer with
      // IN-CONTAINER paths, their mtimes and the head of each file (see container-state.test.js,
      // which proves the real script produces exactly this).
      async inspectState(_target, { globs = [] } = {}) {
        asked.push(...globs);
        const out = [];
        for (const glob of globs) {
          const rel = path.posix.relative(CONTAINER_HOME, glob);
          const from = path.join(volumeDir, rel);
          for (const pair of expandCarryEntry({ rel, from, to: from, kind: "file" })) {
            out.push({
              path: `${CONTAINER_HOME}/${path.relative(volumeDir, pair.from)}`,
              mtimeMs: statSync(pair.from).mtimeMs,
              head: readFileSync(pair.from, "utf8").split("\n").slice(0, 50),
            });
          }
        }
        return out;
      },
    },
  };
}

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
  const spaced = path.join(tempDir("cg-adopt-space-"), "Projects  Customers");
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

test("a session that only exists in the channel's container is adopted through the runtime", async () => {
  // The regression: the daemon's own state dirs hold nothing, the HOME volume is unreadable from
  // here (rootless Podman), and before this the answer was always "I can't find that session".
  const id = "11111111-aaaa-4bbb-8ccc-2222dddd3333";
  const volume = tempDir("cg-adopt-volume-");
  writeContainerClaudeSession(volume, id, CHANNEL_DIR);
  const target = containerTarget(volume);

  const result = await plan(`podman exec -it -w "${CHANNEL_DIR}" cg-test-slack-acme claude --resume ${id}`, { target });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.engine, "claude");
  assert.equal(result.cwd, CHANNEL_DIR);
  assert.deepEqual(target.asked, [`/home/agent/.claude/projects/*/${id}.jsonl`], "the container is asked for its own state dir, not the host's");
});

test("a Codex rollout inside the container is found by its pattern, timestamped filename and all", async () => {
  const id = "44444444-aaaa-4bbb-8ccc-5555dddd6666";
  const volume = tempDir("cg-adopt-volume-codex-");
  writeContainerCodexSession(volume, id, CHANNEL_DIR);
  const target = containerTarget(volume);

  // A bare id in a Claude thread: both stores are searched, and the rollout is adopted AS Codex.
  const result = await plan(id, { target });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.engine, "codex");
  assert.ok(target.asked.includes(`/home/agent/.codex/sessions/*/*/*/*${id}*.jsonl`));
});

test("a HOME volume this host leaves readable is read directly, without entering the container", async () => {
  const id = "77777777-aaaa-4bbb-8ccc-8888dddd9999";
  const volume = tempDir("cg-adopt-volume-open-");
  writeContainerClaudeSession(volume, id, CHANNEL_DIR);
  const target = containerTarget(volume, { readableVolume: true });

  const result = await plan(`claude --resume ${id}`, { target });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(target.asked, [], "a readable volume costs no container start");
});

test("the same-channel rule holds inside the container too", async () => {
  const id = "aaaa1111-aaaa-4bbb-8ccc-bbbb2222cccc";
  const volume = tempDir("cg-adopt-volume-foreign-");
  writeContainerClaudeSession(volume, id, OTHER_DIR);
  const target = containerTarget(volume);

  const result = await plan(`claude --resume ${id}`, { target });
  assert.equal(result.ok, false);
  assert.match(result.message, /only be resumed in the channel that owns its folder/);
});

test("a runtime that cannot be reached refuses rather than crashing the command", async () => {
  const target = containerTarget(tempDir("cg-adopt-volume-down-"));
  target.runtime.inspectState = async () => { throw new Error("no usable container CLI"); };
  const logs = [];
  const result = await plan("claude --resume cccc3333-aaaa-4bbb-8ccc-dddd4444eeee", { target, log: (m) => logs.push(m) });
  assert.equal(result.ok, false);
  assert.match(result.message, /can't find Claude session/);
  assert.ok(logs.some((line) => line.includes("no usable container CLI")), "the real reason is logged, not shown as a missing session");
});

test("the refusal names the harness the pasted command named, not the thread's", async () => {
  const unknown = "eeee5555-aaaa-4bbb-8ccc-ffff6666aaaa";
  // A Claude command pasted into a Codex thread used to come back as a missing "Codex session".
  const claudeInCodexThread = await plan(`claude --resume ${unknown}`, { threadEngine: "codex" });
  assert.equal(claudeInCodexThread.ok, false);
  assert.match(claudeInCodexThread.message, /can't find Claude session/);
  assert.ok(!/Codex session/.test(claudeInCodexThread.message));

  const codexInClaudeThread = await plan(`codex exec resume ${unknown}`, { threadEngine: "claude" });
  assert.match(codexInClaudeThread.message, /can't find Codex session/);

  // A bare id says nothing about its harness, so the refusal claims neither.
  const bare = await plan(unknown, { threadEngine: "codex" });
  assert.match(bare.message, /in Claude's or Codex's history/);
  assert.ok(!/Codex session/.test(bare.message));
});

test("the refusal says where it looked, so 'not here' is actionable", async () => {
  const unknown = "bbbb7777-aaaa-4bbb-8ccc-cccc8888dddd";
  const target = containerTarget(tempDir("cg-adopt-volume-empty-"));
  const inChannel = await plan(`claude --resume ${unknown}`, { target });
  assert.match(inChannel.message, /this channel's container and the gateway's own history/);
  const hostOnly = await plan(`claude --resume ${unknown}`);
  assert.match(hostOnly.message, /the gateway's own history/);
});

// ── Added licenses ────────────────────────────────────────────────────────────────────────────
// A harness's own sign-in keeps its transcripts in the harness's state dir. An added license keeps
// its own, in its own directory — `<home>/.cg-licenses/<id>` in the channel's volume, the license's
// sign-in directory on the host — so a lookup that reads only the harness's directory never sees a
// session started under one. That is how `/resume` came to refuse every such session.
const { createLicense, deleteLicense } = await import("../src/config/engine-licenses.js");
const { saveSettings } = await import("../src/config/settings.js");
const { licenseLoginHome } = await import("../src/engines/license-state.js");

function addedLicense(kind, label, { on = true } = {}) {
  const license = createLicense({ kind, label, type: "subscription" });
  if (on) saveSettings({ engineEnabled: { [license.id]: true } });
  return license;
}

function writeLicenseCodexSession(root, sessionId, cwd) {
  const dir = path.join(root, "sessions", "2026", "11", "22");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `rollout-2026-11-22T10-00-00-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`);
}

function writeLicenseClaudeSession(root, sessionId, cwd) {
  const dir = path.join(root, "projects", adopt.claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", sessionId, cwd, message: { role: "user", content: "hi" } })}\n`);
}

test("a session started under an added license is found in that license's own directory", async () => {
  const license = addedLicense("codex-login", "Team seat");
  try {
    const id = "0a0a0a0a-aaaa-4bbb-8ccc-111111111111";
    const volume = tempDir("cg-adopt-license-");
    writeLicenseCodexSession(path.join(volume, ".cg-licenses", license.id), id, CHANNEL_DIR);
    const target = containerTarget(volume);

    // The line `/resume` prints for a thread on that license, pasted back.
    const pasted = `cd "${CHANNEL_DIR}" && env CODEX_HOME='${CONTAINER_HOME}/.cg-licenses/${license.id}' codex exec resume '${id}'`;
    const result = await plan(pasted, { target, threadEngine: license.id });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.engine, license.id, "the thread continues on the license that holds the session");
    assert.match(result.message, /continues Codex · Team seat session/);
    assert.equal(target.asked[0], `${CONTAINER_HOME}/.cg-licenses/${license.id}/sessions/*/*/*/*${id}*.jsonl`, "the thread's own license is asked first");
  } finally {
    await deleteLicense(license.id);
  }
});

test("a bare id from a thread on the default sign-in is adopted as the license that holds it", async () => {
  const license = addedLicense("claude-login", "Second seat");
  try {
    const id = "0b0b0b0b-aaaa-4bbb-8ccc-222222222222";
    const volume = tempDir("cg-adopt-license-claude-");
    writeLicenseClaudeSession(path.join(volume, ".cg-licenses", license.id), id, CHANNEL_DIR);
    const target = containerTarget(volume);

    const result = await plan(id, { target, threadEngine: "claude" });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.engine, license.id);
    assert.match(result.message, /continues Claude Code · Second seat session/);
  } finally {
    await deleteLicense(license.id);
  }
});

test("a license's session on the host is found in its sign-in directory", async () => {
  const license = addedLicense("codex-login", "Host seat");
  try {
    const id = "0c0c0c0c-aaaa-4bbb-8ccc-333333333333";
    writeLicenseCodexSession(licenseLoginHome(license.id), id, CHANNEL_DIR);
    const result = await plan(`codex exec resume ${id}`, { threadEngine: "claude" });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.engine, license.id);
  } finally {
    await deleteLicense(license.id);
  }
});

test("the same-channel rule holds for a license's sessions", async () => {
  const license = addedLicense("codex-login", "Foreign seat");
  try {
    const id = "0d0d0d0d-aaaa-4bbb-8ccc-444444444444";
    const volume = tempDir("cg-adopt-license-foreign-");
    writeLicenseCodexSession(path.join(volume, ".cg-licenses", license.id), id, OTHER_DIR);
    const result = await plan(id, { target: containerTarget(volume), threadEngine: license.id });
    assert.equal(result.ok, false);
    assert.match(result.message, /only be resumed in the channel that owns its folder/);
  } finally {
    await deleteLicense(license.id);
  }
});

test("a license this conversation may not run on is never searched", async () => {
  const off = addedLicense("codex-login", "Switched off", { on: false });
  const barred = addedLicense("codex-login", "Not approved here");
  try {
    const volume = tempDir("cg-adopt-license-barred-");
    const offId = "0e0e0e0e-aaaa-4bbb-8ccc-555555555555";
    const barredId = "0f0f0f0f-aaaa-4bbb-8ccc-666666666666";
    writeLicenseCodexSession(path.join(volume, ".cg-licenses", off.id), offId, CHANNEL_DIR);
    writeLicenseCodexSession(path.join(volume, ".cg-licenses", barred.id), barredId, CHANNEL_DIR);

    // The channel admits the Codex default sign-in only; one license is off for everybody.
    const target = containerTarget(volume);
    const meta = { approvedEngines: ["claude", "codex"] };
    for (const id of [offId, barredId]) {
      const result = await plan(`codex exec resume ${id}`, { target, meta });
      assert.equal(result.ok, false, "adopting it would pin the thread to a license it may not use");
      assert.match(result.message, /can't find Codex session/);
    }
    assert.ok(!target.asked.some((glob) => glob.includes(off.id) || glob.includes(barred.id)), "neither directory was read");

    // Without the channel's restriction the switched-on license is one of this conversation's.
    const open = await plan(`codex exec resume ${barredId}`, { target: containerTarget(volume) });
    assert.equal(open.ok, true, open.message);
    assert.equal(open.engine, barred.id);
  } finally {
    await deleteLicense(off.id);
    await deleteLicense(barred.id);
  }
});

test("a session that is nowhere says every license was searched", async () => {
  const license = addedLicense("codex-login", "Empty seat");
  try {
    const result = await plan("codex exec resume 1a1a1a1a-aaaa-4bbb-8ccc-777777777777", { target: containerTarget(tempDir("cg-adopt-license-empty-")) });
    assert.equal(result.ok, false);
    assert.match(result.message, /under every license this conversation can use/);
  } finally {
    await deleteLicense(license.id);
  }
});

test("a thread on a license with no terminal form is told its session id instead of a command", async () => {
  const { buildResumeCommand, resumeCommandReply } = await import("../src/slack/footer.js");
  const id = "1b1b1b1b-aaaa-4bbb-8ccc-888888888888";
  const claude = addedLicense("claude-login", "Held seat");
  const codex = addedLicense("codex-login", "Open seat");
  try {
    // The container backend's own facts: an isolated runtime whose resume form is an exec.
    const target = { backend: "container", cwd: CHANNEL_DIR, ...containerTarget(tempDir("cg-adopt-reply-")) };
    target.runtime.capabilities = { isolated: true };
    target.runtime.resumeCommand = (t, { baseCommand }) => `podman exec -it -w '${t.cwd}' ${t.container.name} ${baseCommand}`;
    // A Claude sign-in license in a container: its command only prints why it cannot be taken over.
    const held = resumeCommandReply(buildResumeCommand(CHANNEL_DIR, id, claude.id, target), id, claude.id);
    assert.match(held, /runs on Claude Code · Held seat/);
    assert.match(held, new RegExp(`/resume ${id}`), "the id is what the next thread needs");
    assert.ok(!held.includes("printf"), "the refusing shell line is not offered as something to run");
    // A ChatGPT sign-in license does have one, and it parses back to the same session.
    const open = resumeCommandReply(buildResumeCommand(CHANNEL_DIR, id, codex.id, target), id, codex.id);
    assert.match(open, /Open this thread's session in a terminal/);
    assert.equal(adopt.parseResumeRequest(open.split("```")[1]).sessionId, id);
    assert.match(resumeCommandReply("", "", "claude"), /No session in this thread yet/);
  } finally {
    await deleteLicense(claude.id);
    await deleteLicense(codex.id);
  }
});
