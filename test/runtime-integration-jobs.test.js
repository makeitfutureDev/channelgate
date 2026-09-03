// Background SHELL jobs under the container runtime (v0.8 P1). A job is the hardest case for a
// per-channel runtime because it outlives the turn that launched it AND the daemon that started it:
// it resolves its own target at spawn, must keep that runtime up for its whole life, and after a
// restart can only be found again through the backend — its pid belonged to a client process that
// died with the old daemon.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR ||= path.join(scratch, "workspace");

const { BackgroundJobs, containerJobScript, parseContainerJobExit, stripContainerJobExit } = await import("../src/gateway/background.js");
const { upsertChannelEntry, saveChannelMeta, setUser } = await import("../src/config/store.js");
const { getDb, fromJson } = await import("../src/db/index.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { createFakeRuntimeBackend, fakeTarget, FAKE_CONTAINER, FAKE_IMAGE } = await import("./runtime-fake.js");

async function autoChannel(id, slug) {
  await setUser("U_JOB", { name: "Job User", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(id, { name: slug, type: "channel", isDM: false });
  const meta = { channelId: id, name: slug, type: "channel", autoMode: true, adminMode: false, platform: "slack" };
  await saveChannelMeta(entry.slug, meta);
  mkdirSync(effectiveWorkDir(entry.slug, meta), { recursive: true });
  return { entry, meta };
}

function persistedRow(id) {
  const row = getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(id);
  return row ? fromJson(row.data, null) : null;
}

test("the job wrapper writes its own log and records an exit status the daemon can read back", () => {
  const script = containerJobScript("npm test", "/work/.runtime/jobs/abc.log");
  // A detached exec hands back no stdio, so the job redirects itself into the file the artifact
  // mount makes identical on both sides — that file IS the daemon's view of the job.
  assert.match(script, /^exec >'\/work\/\.runtime\/jobs\/abc\.log' 2>&1\n/);
  assert.match(script, /\nnpm test\n/);
  assert.match(script, /cg-exit/);
  // A path with a quote in it must not break out of the redirect.
  assert.match(containerJobScript("ls", "/tmp/o'ops.log"), /'\/tmp\/o'\\''ops\.log'/);

  assert.equal(parseContainerJobExit("some output\n\n[cg-exit:0]\n"), 0);
  assert.equal(parseContainerJobExit("boom\n\n[cg-exit:17]\n"), 17);
  // No marker means the wrapper never got to write one (the job called `exit`, or was killed):
  // "unknown", never a fabricated success.
  assert.equal(parseContainerJobExit("output with no marker"), null);
  assert.equal(stripContainerJobExit("output\n\n[cg-exit:0]\n"), "output");
});

test("a shell job in an isolated runtime spawns through the backend, holds a lease, and records where it ran", async () => {
  const backend = createFakeRuntimeBackend();
  const { entry } = await autoChannel("C_JOB_CTR", "job-ctr");
  // Auto mode still requires an admin to sign off on the exact command; that gate is not what
  // this test is about, so it is answered rather than bypassed.
  const approve = async () => ({ allow: true, decidedBy: "U_JOB" });
  const jobs = new BackgroundJobs({ requestShellApproval: approve, resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta) });

  const started = await jobs.start({ channelId: "C_JOB_CTR", authorId: "U_JOB", threadKey: "t-ctr", command: "echo hello", label: "echo" });
  assert.equal(started.ok, true, started.error);

  // The runtime is made ready before the job is put into it, and held up for its whole life.
  assert.equal(backend.calls.ensureUp.length, 1);
  assert.deepEqual(backend.calls.leases.map((l) => l.kind), ["job"]);
  assert.equal(backend.calls.leases[0].released, false, "a running job keeps its lease");

  // The spawn crossed the backend seam, detached, tagged with the runId the row remembers.
  const spawn = backend.calls.spawn.at(-1);
  assert.equal(spawn.cmd, "bash");
  assert.equal(spawn.detached, true);
  assert.equal(spawn.kind, "job");
  assert.match(spawn.runId, /^job-/);
  assert.match(spawn.args[1], /^exec >'/, "the command was wrapped so the job writes its own log");

  const row = persistedRow(started.id);
  assert.deepEqual(row.runtime, { backend: "container", runId: spawn.runId, container: FAKE_CONTAINER });
  // The log path is inside the channel's artifact dir — the one place both sides can reach.
  const target = fakeTarget(backend, entry.slug, { platform: "slack" });
  assert.ok(row.logFile.startsWith(path.join(target.artifactDir, "jobs")), row.logFile);
});

test("a recovered container job is probed and signalled through the backend, never by pid", async () => {
  const backend = createFakeRuntimeBackend();
  const { entry } = await autoChannel("C_JOB_RECOVER", "job-recover");
  const target = fakeTarget(backend, entry.slug, { platform: "slack" });
  mkdirSync(path.join(target.artifactDir, "jobs"), { recursive: true });
  const logFile = path.join(target.artifactDir, "jobs", "recover.log");
  writeFileSync(logFile, "partial output\n");

  // A durable row exactly as _persist writes it, for a job whose daemon has since restarted. The
  // recorded pid belongs to a client process that is long gone, so anything derived from it would
  // be a guess — a recycled pid at best, a stranger's process group at worst.
  getDb().prepare("INSERT INTO bg_jobs(id, data) VALUES(?, ?)").run("recover1", JSON.stringify({
    id: "recover1", kind: "shell", channelId: "C_JOB_RECOVER", slug: entry.slug, authorId: "U_JOB",
    threadKey: "t-recover", label: "long build", command: "sleep 600", startedAt: Date.now() - 1000,
    pid: 999999, startTime: "", maxMs: 60_000, logFile,
    runtime: { backend: "container", runId: "job-abc123", container: FAKE_CONTAINER },
  }));

  const jobs = new BackgroundJobs({ resolveTarget: () => target, deliver: async () => {} });
  backend.alive = true;
  await jobs.recover();

  // Liveness came from the backend's probe on the recorded runId — not from process.kill(pid, 0).
  assert.ok(backend.calls.probe.includes("job-abc123"), "the recovered job was probed through the backend");
  const status = jobs.status("recover1");
  assert.ok(status, "a job the backend says is alive keeps being tracked");
  assert.match(status.tail, /partial output/);
});

test("a recovered container job the backend says is gone is finished, not signalled", async () => {
  const backend = createFakeRuntimeBackend();
  const { entry } = await autoChannel("C_JOB_GONE", "job-gone");
  const target = fakeTarget(backend, entry.slug, { platform: "slack" });
  getDb().prepare("INSERT INTO bg_jobs(id, data) VALUES(?, ?)").run("gone1", JSON.stringify({
    id: "gone1", kind: "shell", channelId: "C_JOB_GONE", slug: entry.slug, authorId: "U_JOB",
    threadKey: "t-gone", label: "short job", command: "true", startedAt: Date.now() - 1000,
    pid: 999998, startTime: "", maxMs: 60_000, logFile: "",
    runtime: { backend: "container", runId: "job-gone", container: FAKE_CONTAINER },
  }));

  backend.alive = false;
  const jobs = new BackgroundJobs({ resolveTarget: () => target, deliver: async () => {} });
  await jobs.recover();

  assert.ok(backend.calls.probe.includes("job-gone"));
  // Identity first, then signals: a job we cannot vouch for is declared finished, never killed.
  assert.deepEqual(backend.calls.signal, []);
});

test("the approval card describes the environment the job will actually run in", async () => {
  // The second click used to exist because a shell job was plain bash on the daemon account. In a
  // container channel that claim is false — and the approver's real question ("which image?")
  // went unanswered. The wording is capability-driven, not a backend-id branch, and it names the
  // image.
  await autoChannel("C_JOB_CARD", "job-card");
  const asked = [];
  const deny = async (request) => {
    asked.push(request);
    return { allow: false, reason: "not approved in this test" };
  };

  const backend = createFakeRuntimeBackend();
  const inContainer = new BackgroundJobs({ requestShellApproval: deny, resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta) });
  const containerRefusal = await inContainer.start({ channelId: "C_JOB_CARD", authorId: "U_JOB", threadKey: "t-card-ctr", command: "rm -rf build", label: "clean" });
  assert.equal(containerRefusal.ok, false);
  const containerCard = asked.at(-1);
  assert.equal(containerCard.toolName, "Background shell job (in this channel's container)");
  assert.match(containerCard.toolInput.details, /Runs inside this channel's container \(channelgate\/runtime:test\)/);
  assert.ok(containerCard.toolInput.details.includes(FAKE_IMAGE), "the approver must be told which image");
  assert.doesNotMatch(containerCard.toolInput.details, /unsandboxed|as the daemon user/i);
  assert.doesNotMatch(containerRefusal.error, /unsandboxed on the daemon/);
  // Still an admin-tier click: less dangerous is not "no approval".
  assert.equal(containerCard.requiredTier, "admin");
  assert.equal(containerCard.approvalType, "agent");
});
