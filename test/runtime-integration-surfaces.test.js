// What a person SEES of the container runtime, plus the two durable records behind it. A channel
// that runs behind an OS boundary must say so in the places someone actually looks — /status, the
// liveness row, the reply footer, /resume — or the boundary becomes invisible state that only
// explains itself when something breaks.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR ||= path.join(scratch, "workspace");
// A container Claude run — the memory reviewer included — authenticates with a relay of the
// gateway's resolved login (src/gateway/claude-login.js). Give the scratch daemon the normal one:
// the operator's own ~/.claude, which test/helpers.js pins into the scratch dir.
{
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const file = path.join(operatorClaudeConfigDir(), ".credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-surfaces", expiresAt: Date.now() + 4 * 3600_000, refreshTokenExpiresAt: Date.now() + 20 * 24 * 3600_000 } }), { mode: 0o600 });
}

const { formatRuntimeLine, formatCapabilityLine, buildStatusReport } = await import("../src/slack/status-controller.js");
const { NETWORK_ADVISORY_NOTE } = await import("../src/engines/network-policy.js");
const { buildResumeCommand, footerText } = await import("../src/slack/footer.js");
const { getDb } = await import("../src/db/index.js");
const { saveSession, resolveSession, getSessionRuntime, clearSession } = await import("../src/gateway/sessions.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const adopt = await import("../src/gateway/session-adopt.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { createFakeRuntimeBackend, fakeTarget, FAKE_CONTAINER, FAKE_IMAGE } = await import("./runtime-fake.js");
const { runMemoryReview } = await import("../src/gateway/memory-review.js");
const { readMemorySnapshot } = await import("../src/gateway/channel-memory.js");

const backend = createFakeRuntimeBackend();

test("/status names the whole environment: the container, its image, state and uptime", async () => {
  const line = formatRuntimeLine(await backend.describe(fakeTarget(backend, "rt-status", { platform: "slack" })));
  assert.match(line, /^\*📦 Runtime\*: container — /);
  assert.match(line, new RegExp(FAKE_CONTAINER));
  assert.match(line, new RegExp(`image ${FAKE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(line, /running/);
  assert.match(line, /up 1m|up 2m|up 9\ds/);
});

test("/status names the channel's own switches, network included, in both directions", async () => {
  // The gap this closes: /status listed jobs, schedules, runtime and login but never said what the
  // channel was allowed to DO, and the mode label said nothing at all when the network was off —
  // so "can I reach the internet from here?" had no answer anywhere in chat.
  assert.equal(formatCapabilityLine({}), `*🎚️ Mode*: Read-only · network off (${NETWORK_ADVISORY_NOTE})`);
  assert.equal(formatCapabilityLine({ allowBash: true, allowNetwork: true, engine: "claude" }), "*🎚️ Mode*: Bash · network on");

  const entry = await upsertChannelEntry("C_RT_NETSTATE", { name: "rt-netstate", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: "C_RT_NETSTATE", platform: "slack", name: "rt-netstate", allowBash: true });
  const off = await buildStatusReport(entry.slug, "C_RT_NETSTATE");
  assert.match(off, /Mode\*: Bash · network off/, "an off switch is stated, not left to inference");
  assert.match(off, new RegExp(NETWORK_ADVISORY_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and it is honest about not being enforced");

  await saveChannelMeta(entry.slug, { channelId: "C_RT_NETSTATE", platform: "slack", name: "rt-netstate", allowBash: true, allowNetwork: true });
  assert.match(await buildStatusReport(entry.slug, "C_RT_NETSTATE"), /Mode\*: Bash · network on/);
});

test("a quiet channel's /status still says where its turns run", async () => {
  const entry = await upsertChannelEntry("C_RT_STATUS", { name: "rt-status-line", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: "C_RT_STATUS", platform: "slack", name: "rt-status-line" });
  const report = await buildStatusReport(entry.slug, "C_RT_STATUS");
  assert.match(report, /Nothing is running or scheduled/);
  assert.match(report, /Mode\*: Read-only · network off/, "even the empty report carries the switches");
  // Through the REAL resolver: a channel that has never run still resolves to its container, and
  // the line names it even when the container CLI is missing on this machine (the state then says
  // so — an unavailable backend is exactly when someone types /status).
  assert.match(report, /Runtime\*: container — /);
  assert.match(report, new RegExp(`\`cg-[^\`]*${entry.slug}[^\`]*\``), "the channel's own container is named");
});

test("the reply footer names the image for a container turn and is unchanged for a host turn", () => {
  const usage = { input_tokens: 1000, output_tokens: 20 };
  const host = footerText({ engine: "claude", model: "opus-4.8", usage, durationMs: 1200, costUSD: 0.01 });
  assert.doesNotMatch(host, /channelgate\/runtime/);

  const contained = footerText({ engine: "claude", model: "opus-4.8", usage, durationMs: 1200, costUSD: 0.01, runtime: { backend: "container", image: FAKE_IMAGE } });
  assert.equal(contained, `${host} · ${FAKE_IMAGE}`, "the image is appended, nothing else moves");
});

test("/resume prints the command that actually reopens the session where it lives", () => {
  const cwd = "/home/agent/work/acme";
  const plain = buildResumeCommand(cwd, "sess-1", "claude");
  assert.equal(plain, `cd ${JSON.stringify(cwd)} && claude --resume sess-1`);
  // A target that adds nothing — the daemon's own local one — must not change that line by a byte.
  assert.equal(buildResumeCommand(cwd, "sess-1", "claude", localRuntimeTarget(cwd)), plain);

  // A session minted inside a container does not exist on the host, so the backend supplies the
  // form that reopens it — and the redundant `cd` is gone with it.
  const contained = buildResumeCommand(cwd, "sess-1", "claude", fakeTarget(backend, "rt-resume", { platform: "slack" }));
  assert.equal(contained, `docker exec -it ${FAKE_CONTAINER} claude --resume sess-1`);
  assert.equal(buildResumeCommand("", "sess-1", "claude"), "", "no cwd, nothing to resume");
});

test("the liveness row marks an isolated turn, and says nothing extra for a host one", async () => {
  // The heartbeat label is built inside the streaming progress closure; the rule it encodes is
  // that the suffix comes from the run's DECLARED isolation, never from a backend id.
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/slack/progress.js", import.meta.url), "utf8"));
  assert.match(source, /runtime\?\.isolated.*runtimeSuffix = " · container"/s);
  assert.match(source, /⏳ Working — \$\{elapsed\}\$\{runtimeSuffix\}/);
  assert.doesNotMatch(source, /backend === "container"/);
});

test("migration 13 is additive: existing session rows read as host rows", async () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  assert.ok(columns.includes("runtime"), "the column exists after the migration runs at open");

  // A row written the old way (no runtime column value) — exactly what every pre-v0.8 row looks
  // like. It must not throw, and it must not claim to be anything but a host session.
  db.prepare("INSERT INTO sessions(slug, thread_key, session_id, engine) VALUES(?, ?, ?, ?)").run("rt-legacy", "t1", "legacy-session", "claude");
  assert.equal(await getSessionRuntime("rt-legacy", "t1"), null);

  await saveSession("rt-legacy", "t2", "new-session", "claude", null, JSON.stringify({ backend: "container", fingerprint: "fp", image: FAKE_IMAGE }));
  assert.deepEqual(await getSessionRuntime("rt-legacy", "t2"), { backend: "container", fingerprint: "fp", image: FAKE_IMAGE });

  // A minted session carries the stamp it was minted with; /clear wipes it with the rest of the row.
  const minted = await resolveSession("rt-legacy", "t3", "claude", JSON.stringify({ backend: "container", fingerprint: "fp", image: FAKE_IMAGE }));
  assert.equal(minted.isNew, true);
  assert.equal((await getSessionRuntime("rt-legacy", "t3")).backend, "container");
  await clearSession("rt-legacy", "t3");
  assert.equal(await getSessionRuntime("rt-legacy", "t3"), null);

  // Garbage in the column is a display problem, never a crash on the path that reads it.
  db.prepare("UPDATE sessions SET runtime = 'not json' WHERE slug = ? AND thread_key = ?").run("rt-legacy", "t2");
  assert.equal(await getSessionRuntime("rt-legacy", "t2"), null);
});

test("a container session's recorded cwd still passes the same-channel adoption rule", async () => {
  // The container mounts the work dir at the IDENTICAL absolute path, which is precisely what
  // keeps `/resume` adoption working: the transcript the engine wrote inside the container records
  // the same cwd the daemon would compute for the channel on the host.
  const channelDir = tempDir("cg-rt-adopt-");
  const state = tempDir("cg-rt-state-");
  const sessionId = "8b1d0f2a-2222-4c31-9d55-77aa22bb33cc";
  const dir = path.join(state, "projects", adopt.claudeProjectDirName(channelDir));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", sessionId, cwd: channelDir, message: { role: "user", content: "hi" } })}\n`);

  const plan = await adopt.planSessionAdoption({
    arg: `docker exec -it ${FAKE_CONTAINER} claude --resume ${sessionId}`,
    slug: "rt-adopt",
    threadKey: "1700000000.000900",
    workDir: channelDir,
    threadEngine: "claude",
    dirs: { claude: state, codex: path.join(state, "codex") },
  });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(plan.cwd, channelDir);
});

test("a memory review runs through the backend: warmed up, leased, and reading only mounted paths", async () => {
  const entry = await upsertChannelEntry("C_RT_REVIEW", { name: "rt-review", type: "channel" });
  const meta = { channelId: "C_RT_REVIEW", name: "rt-review", platform: "slack", memory: true, allowedMcps: [] };
  await saveChannelMeta(entry.slug, meta);
  const target = fakeTarget(backend, entry.slug, meta);
  mkdirSync(target.cwd, { recursive: true });
  mkdirSync(target.artifactDir, { recursive: true, mode: 0o700 });
  await readMemorySnapshot(target.cwd, meta);

  const seen = [];
  const before = backend.calls.leases.length;
  await runMemoryReview({
    channelId: "C_RT_REVIEW",
    slug: entry.slug,
    threadKey: "t-review",
    authorId: "U_RT",
    meta,
    fetchTranscript: async () => "user: always use tabs\nassistant: noted",
    resolveTarget: () => target,
    run: async (args) => {
      seen.push(args);
      return { content: "Nothing to save.", usage: {}, costUSD: 0, durationMs: 5 };
    },
  });

  const lease = backend.calls.leases.slice(before).find((l) => l.kind === "review");
  assert.ok(lease, "the review holds a review lease");
  assert.equal(lease.released, true, "…and gives it back when it finishes");
  assert.ok(backend.calls.ensureUp.length > 0, "the runtime is made ready before the reviewer runs");

  const call = seen.at(-1);
  // Every file the reviewer's engine has to open lives under the mounted artifact dir, and its
  // HOME is the image's — the daemon's engine state and metadata folder are not mounted.
  assert.ok(call.mcpConfig.startsWith(`${target.artifactDir}${path.sep}`), call.mcpConfig);
  assert.ok(call.settingsFile.startsWith(`${target.artifactDir}${path.sep}`), call.settingsFile);
  assert.equal(call.home, "/home/agent");
  assert.equal(call.configDir, "/home/agent/.claude");
  assert.equal(call.target, target);
});
