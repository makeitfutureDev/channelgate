// Background SHELL jobs under the container runtime (v0.8 P1). A job is the hardest case for a
// per-channel runtime because it outlives the turn that launched it AND the daemon that started it:
// it resolves its own target at spawn, must keep that runtime up for its whole life, and after a
// restart can only be found again through the backend — its pid belonged to a client process that
// died with the old daemon.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  // The runtime-side wrapper owns both pipes and persists only redacted output to the artifact
  // mount. It receives command/path/secret NAMES as data, never secret values.
  assert.match(script, /^exec node --input-type=module -e /);
  assert.match(script, /-- 'npm test' '\/work\/\.runtime\/jobs\/abc\.log'/);
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
  const { entry, meta } = await autoChannel("C_JOB_CTR", "job-ctr");
  const canary = "synthetic-job-log-canary";
  await saveChannelMeta(entry.slug, { ...meta, env: { QA_BG_CANARY: { provider: "local", value: canary }, MAKE_BASE_URL: { provider: "local", value: "https://public.example.test" } } });
  // Auto mode still requires an admin to sign off on the exact command; that gate is not what
  // this test is about, so it is answered rather than bypassed.
  const approve = async () => ({ allow: true, decidedBy: "U_JOB" });
  const jobs = new BackgroundJobs({ requestShellApproval: approve, resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta) });

  const started = await jobs.start({ channelId: "C_JOB_CTR", authorId: "U_JOB", threadKey: "t-ctr", command: 'printf "%s %s" "$MAKE_BASE_URL" "$QA_BG_CANARY"', label: "echo" });
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
  assert.equal(spawn.args[0], "-c", "only the inner command shell is a login shell");
  assert.match(spawn.args[1], /^exec node /, "the command was wrapped so redaction precedes durable logging");
  assert.match(spawn.args[1], /\["QA_BG_CANARY"\]/);
  assert.equal(spawn.args[1].includes(canary), false, "the wrapper receives names, never resolved values in argv");
  assert.equal(spawn.env.QA_BG_CANARY, canary, "the existing job environment supplies the secret");
  assert.ok(!spawn.args[1].includes('"MAKE_BASE_URL"'), "readable config is excluded from wrapper redaction names");
  for (let i = 0; i < 100; i++) {
    let log = "";
    try { log = readFileSync(persistedRow(started.id).logFile, "utf8"); } catch {}
    if (parseContainerJobExit(log) !== null) {
      assert.match(log, /https:\/\/public\.example\.test \[REDACTED\]/);
      break;
    }
    assert.ok(i < 99, "job completed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const row = persistedRow(started.id);
  assert.deepEqual(row.runtime, { backend: "container", runId: spawn.runId, container: FAKE_CONTAINER });
  // The log path is inside the channel's artifact dir — the one place both sides can reach.
  const target = fakeTarget(backend, entry.slug, { platform: "slack" });
  assert.ok(row.logFile.startsWith(path.join(target.artifactDir, "jobs")), row.logFile);
});

test("a recovered container job is probed and signalled through the backend, never by pid", async () => {
  const backend = createFakeRuntimeBackend();
  const { entry, meta } = await autoChannel("C_JOB_RECOVER", "job-recover");
  await saveChannelMeta(entry.slug, { ...meta, env: {
    MAKE_BASE_URL: { provider: "local", value: "https://public.example.test" },
    QA_HIDDEN_KEY: { provider: "local", value: "recovery-hidden-fixture", exposure: "hidden" },
  } });
  const target = fakeTarget(backend, entry.slug, { platform: "slack" });
  mkdirSync(path.join(target.artifactDir, "jobs"), { recursive: true });
  const logFile = path.join(target.artifactDir, "jobs", "recover.log");
  writeFileSync(logFile, "partial output https://public.example.test recovery-hidden-fixture\n");

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
  assert.match(status.tail, /partial output https:\/\/public\.example\.test \[REDACTED\]/);
  assert.ok(!status.tail.includes("recovery-hidden-fixture"));
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

test("a container job in Auto mode starts without a card; an unisolated one still gets the admin-tier card", async () => {
  // The second click used to exist because a shell job was plain bash on the daemon account. In a
  // container channel that claim is false, and Auto mode already auto-approves every foreground
  // command in that same container — so the container job starts directly, as the author's own
  // work, and only an UNISOLATED target still posts the exact-command card (admin tier, naming the
  // daemon account). The wording is capability-driven, not a backend-id branch.
  await autoChannel("C_JOB_CARD", "job-card");
  const asked = [];
  const deny = async (request) => {
    asked.push(request);
    return { allow: false, reason: "not approved in this test" };
  };

  const backend = createFakeRuntimeBackend();
  const inContainer = new BackgroundJobs({ requestShellApproval: deny, resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta) });
  const containerStart = await inContainer.start({ channelId: "C_JOB_CARD", authorId: "U_JOB", threadKey: "t-card-ctr", command: "true", label: "clean" });
  assert.equal(containerStart.ok, true, containerStart.error);
  assert.equal(containerStart.pendingApproval, undefined);
  assert.equal(asked.length, 0, "no card for a container job in Auto mode");
  assert.equal(backend.calls.spawn.length, 1, "the job was spawned through the container backend");
  assert.equal(backend.calls.spawn[0].kind, "job");
  const deadline = Date.now() + 15_000;
  while (inContainer.count() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(inContainer.count(), 0);

  const hostBackend = createFakeRuntimeBackend({ isolated: false });
  const onHost = new BackgroundJobs({ requestShellApproval: deny, resolveTarget: (slug, meta) => fakeTarget(hostBackend, slug, meta) });
  const hostRefusal = await onHost.start({ channelId: "C_JOB_CARD", authorId: "U_JOB", threadKey: "t-card-host", command: "rm -rf build", label: "clean" });
  assert.equal(hostRefusal.ok, false);
  assert.equal(hostBackend.calls.spawn.length, 0, "a denied host job never spawns");
  const hostCard = asked.at(-1);
  assert.equal(hostCard.toolName, "Background shell job (unsandboxed)");
  assert.match(hostCard.toolInput.details, /as the daemon user/i);
  assert.doesNotMatch(hostCard.toolInput.details, /container/i);
  // Still an admin-tier click: outside a container, less convenient is not "no approval".
  assert.equal(hostCard.requiredTier, "admin");
  assert.equal(hostCard.approvalType, "agent");
  assert.match(hostRefusal.error, /run outside every container/);
});

test("proxy-mode background jobs redact hidden placeholders before persistence and preserve readable config", async () => {
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const backend = createFakeRuntimeBackend({ egress: { active: true, mode: "proxy", network: "none" } });
  const channelId = "C_JOB_PROXY_REDACT";
  const { entry, meta } = await autoChannel(channelId, "job-proxy-redact");
  const hidden = "synthetic-hidden-" + randomBytes(16).toString("hex");
  const readable = "intentionally-readable-" + randomBytes(8).toString("hex");
  await saveChannelMeta(entry.slug, { ...meta, env: {
    QA_HIDDEN_RULED: { provider: "local", value: hidden, exposure: "hidden", hosts: ["example.com"] },
    QA_READABLE_CONFIG: { provider: "local", value: readable, exposure: "readable" },
  } });
  const continuations = [], delivered = [];
  const jobs = new BackgroundJobs({
    resolveTarget: (slug, currentMeta) => fakeTarget(backend, slug, currentMeta),
    runner: async ({ text }) => {
      continuations.push(text);
      return { content: "safe fixture summary", engine: "claude" };
    },
    deliver: async (_client, { result }) => { delivered.push(result.content); },
  });
  // Keep completion pending until its durable log and status have both been inspected.
  jobs._client = () => null;
  const source = `const s=process.env.QA_HIDDEN_RULED;
    process.stdout.write('full '+s+'\\n');
    process.stdout.write('out '+s.slice(0,12));
    setTimeout(()=>process.stderr.write('err '+s.slice(0,17)),20);
    setTimeout(()=>process.stdout.write(s.slice(12)+' end\\n'),40);
    setTimeout(()=>process.stderr.write(s.slice(17)+' end\\n'),60);
    setTimeout(()=>process.stdout.write('visible '+process.env.QA_READABLE_CONFIG+'\\n'),80);`;
  const started = await jobs.start({
    channelId, authorId: "U_JOB", threadKey: "proxy-redaction", label: "safe synthetic integration",
    command: "node -e " + quote(source),
  });
  assert.equal(started.ok, true, started.error);
  const rec = jobs.jobs.get(started.id);
  const spec = backend.calls.spawn.at(-1);
  const placeholder = spec.env.QA_HIDDEN_RULED;
  assert.notEqual(placeholder, hidden, "the actual resolver replaces hidden values in proxy mode");
  assert.match(placeholder, /^cgph_/);
  assert.equal(spec.env.QA_READABLE_CONFIG, readable);
  const deadline = Date.now() + 12_000;
  while (!rec.pendingDelivery && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(rec.pendingDelivery, "the actual wrapper must finish and checkpoint completion");
  const raw = readFileSync(rec.logFile, "utf8");
  const status = jobs.status(started.id);
  jobs._client = () => ({ platform: "slack", post: async () => ({ ok: true }) });
  await jobs._deliver(rec);

  // Check booleans so a failing assertion cannot print the disposable credential or placeholder.
  for (const text of [raw, status.tail, continuations.join("\n")]) {
    assert.equal(text.includes(hidden), false, "no real hidden value reaches output");
    assert.equal(text.includes(placeholder), false, "no hidden placeholder reaches output");
    assert.equal(text.includes(placeholder.slice(0, 12)), false, "interleaved writes cannot expose a held prefix");
    assert.equal(text.includes(readable), true, "explicit readable configuration remains shareable");
    assert.equal((text.match(/\[REDACTED\]/g) || []).length, 3);
  }
  assert.ok(spec.args[1].includes('["QA_HIDDEN_RULED"]'), "the wrapper receives the hidden env name");
  assert.equal(spec.args.join("").includes(hidden) || spec.args.join("").includes(placeholder), false);
  assert.equal(parseContainerJobExit(raw), 0);
  assert.equal(continuations.length, 1);
  assert.deepEqual(delivered, ["safe fixture summary"]);
  assert.equal(persistedRow(started.id), null, "successful continuation retires the durable row");
  assert.ok(backend.calls.leases.every((lease) => lease.released));
});

test("isolated job poller preserves known exit codes in audit and keeps missing markers unknown", async () => {
  const backend = createFakeRuntimeBackend();
  let unknownSlug = "";
  let holdUnknownProbe = true;
  const probe = backend.probe.bind(backend);
  backend.probe = async (child) => {
    // Keep the real poller observing this fixture as live until its marker has been removed.
    // Slow CI must not finish the job between the wrapper write and the negative-control edit.
    if (holdUnknownProbe && child?.runtime?.target?.slug === unknownSlug) return true;
    return probe(child);
  };
  const continuations = [], notices = [], delivered = [];
  const jobs = new BackgroundJobs({
    resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta),
    runner: async ({ text, threadKey }) => {
      continuations.push({ text, threadKey });
      return { content: "Safe fixture result", engine: "claude" };
    },
    deliver: async (_client, payload) => { delivered.push(payload.threadKey); },
  });
  jobs._client = () => null;
  const fixtures = [];
  for (const expected of [0, 23, null]) {
    const suffix = expected === null ? "unknown" : String(expected);
    const channelId = "C_JOB_EXIT_" + suffix;
    const { entry } = await autoChannel(channelId, "job-exit-" + suffix);
    if (expected === null) unknownSlug = entry.slug;
    const started = await jobs.start({
      channelId, authorId: "U_JOB", threadKey: "exit-" + suffix, label: "safe outcome fixture",
      command: "printf 'prepared-safe-marker\\n'; exit " + (expected ?? 0),
    });
    assert.equal(started.ok, true, started.error);
    fixtures.push({ expected, rec: jobs.jobs.get(started.id) });
  }
  // Simulate an incomplete durable log only after the actual wrapper has written its marker.
  // This negative control must never turn an unconfirmed result into a fabricated zero exit.
  const unknown = fixtures.find((fixture) => fixture.expected === null).rec;
  const markerDeadline = Date.now() + 10_000;
  let completeLog = "";
  while (Date.now() < markerDeadline) {
    try { completeLog = readFileSync(unknown.logFile, "utf8"); } catch {}
    if (parseContainerJobExit(completeLog) !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(parseContainerJobExit(completeLog), 0, "the real wrapper finished before the fixture truncation");
  writeFileSync(unknown.logFile, stripContainerJobExit(completeLog));
  holdUnknownProbe = false;
  const deadline = Date.now() + 12_000;
  while (fixtures.some(({ rec }) => !rec.pendingDelivery) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const { expected, rec } of fixtures) {
    assert.ok(rec.pendingDelivery, "the actual poller checkpoints each finished job");
    assert.equal(parseContainerJobExit(readFileSync(rec.logFile, "utf8")), expected);
    const event = getDb().prepare("SELECT data FROM events WHERE event = 'bg_finish' ORDER BY id DESC")
      .all().map(({ data }) => JSON.parse(data)).find((item) => item.id === rec.id);
    assert.equal(event.exitCode, expected, "structured audit retains exactly the observed exit code");
    assert.equal(event.ok, expected === null ? null : expected === 0);
    assert.equal(persistedRow(rec.id).pendingDelivery.outcome.ok, event.ok);
  }
  jobs._client = () => ({ platform: "slack", post: async ({ text }) => { notices.push(text); return { ok: true }; } });
  for (const { rec } of fixtures) await jobs._deliver(rec);
  assert.equal(continuations.length, 3);
  assert.equal(delivered.length, 3);
  for (const text of [...notices, ...continuations.map((item) => item.text)]) {
    assert.doesNotMatch(text, /exit code|cg-exit:/i, "semantic completion prose remains unchanged");
  }
  assert.ok(continuations.some(({ text }) => text.includes("recorded outcome is success")));
  assert.ok(continuations.some(({ text }) => text.includes("recorded outcome is failure")));
  assert.ok(continuations.some(({ text }) => text.includes("recorded outcome is unknown")));
  assert.ok(fixtures.every(({ rec }) => persistedRow(rec.id) === null));
  assert.ok(backend.calls.leases.every((lease) => lease.released));
});
