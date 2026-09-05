// The daemon runs UNSANDBOXED while the agent can rewrite its own workspace between (and during)
// turns. Every gateway-managed file that lives beneath a channel folder is therefore a sink: if a
// planted symlink is followed, the daemon either reads host secrets into agent-visible files or
// writes agent-chosen bytes over a host file (a shell rc file is delayed code execution).
//
// Each test below plants a hostile symlink at a managed path, runs the real sink, and asserts the
// same two things: the LINK TARGET is byte-for-byte untouched, and the managed path is now a real
// file/directory. Also covered: attachment name collisions, the raw-topic guard in front of
// slugify(), and YAML quoting of the remote library description.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile, symlink, lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
// Point the visible workspace root at scratch BEFORE importing anything that resolves it, so no
// test ever provisions a folder in the operator's real ~/Slack Agent.
process.env.CG_WORKSPACE_DIR ||= await mkdtemp(path.join(os.tmpdir(), "cg-ws-"));

const [{ readNoFollow, writeNoFollow, writeStreamNoFollow, createExclusive, ensureRealDir }, memory, guide, folders, librarySkills, apiRuns, pipeline, paths, attachments, { ATTACHMENT_MAX_BYTES }] =
  await Promise.all([
    import("../src/gateway/safe-fs.js"),
    import("../src/gateway/channel-memory.js"),
    import("../src/gateway/guide.js"),
    import("../src/gateway/folders.js"),
    import("../src/gateway/library-skills.js"),
    import("../src/gateway/api-runs.js"),
    import("../src/slack/message-pipeline.js"),
    import("../src/config/paths.js"),
    import("../src/platforms/attachments.js"),
    import("../src/util/bounded-bytes.js"),
  ]);

const SECRET = "SECRET-HOST-BYTES\n";

// A scratch pair: `cwd` stands in for the agent-writable channel folder, `outside` for host files
// the agent must never reach through a link it planted.
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(cwd, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, cwd, outside };
}

// Plant `link` pointing at a fresh outside file holding SECRET. Returns the victim's path.
async function plantFileLink(link, outside, name) {
  const victim = path.join(outside, name);
  await writeFile(victim, SECRET);
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(victim, link);
  return victim;
}

async function assertReplacedNode(managedPath, victim) {
  assert.equal(await readFile(victim, "utf8"), SECRET, `link target ${victim} must be untouched`);
  assert.equal((await lstat(managedPath)).isSymbolicLink(), false, `${managedPath} must no longer be a symlink`);
}

// ── safe-fs primitives ────────────────────────────────────────────────────────

test("readNoFollow reports a planted symlink as absent instead of reading through it", async (t) => {
  const { cwd, outside } = await scratch(t);
  const managed = path.join(cwd, "MANAGED.md");
  await plantFileLink(managed, outside, "secrets.txt");

  assert.equal(await readNoFollow(managed), null);
  await writeFile(path.join(cwd, "real.md"), "hello\n");
  assert.equal(await readNoFollow(path.join(cwd, "real.md")), "hello\n");
  assert.equal(await readNoFollow(path.join(cwd, "missing.md")), null);
});

test("readNoFollow rethrows a REAL read failure instead of reporting the file as empty", async (t) => {
  // "absent" must mean exactly three things: ENOENT, or the two spellings of "O_NOFOLLOW refused a
  // symlink" (EMLINK/ELOOP). A bare catch also swallowed EACCES/EIO/EISDIR — and channel-memory's
  // `add` is a read-modify-WRITE, so an unreadable MEMORY.md was treated as empty and the very next
  // add blanked the file. Data loss wearing a symlink guard's clothing.
  const { cwd } = await scratch(t);
  // A chmod(000) fixture is still readable under CAP_DAC_OVERRIDE. NAME_MAX is deterministic on
  // every supported Linux filesystem and exercises the same "not an absent code" branch.
  const invalid = path.join(cwd, "x".repeat(256));
  await assert.rejects(readNoFollow(invalid), { code: "ENAMETOOLONG" });
  // A DIRECTORY squatting on a managed file name stays "absent" — folders.js relies on that to
  // rm -r the agent-planted junk instead of wedging every later turn.
  const dir = path.join(cwd, "AGENTS.md");
  await mkdir(dir);
  assert.equal(await readNoFollow(dir), null);
});

test("writeNoFollow replaces a symlink node atomically and leaves no temp files behind", async (t) => {
  const { cwd, outside } = await scratch(t);
  const managed = path.join(cwd, "MANAGED.md");
  const victim = await plantFileLink(managed, outside, "secrets.txt");

  await writeNoFollow(managed, "managed content\n");

  await assertReplacedNode(managed, victim);
  assert.equal(await readFile(managed, "utf8"), "managed content\n");
  assert.deepEqual(await readdir(cwd), ["MANAGED.md"]);
});

test("createExclusive refuses any existing node — including a dangling symlink", async (t) => {
  const { cwd, outside } = await scratch(t);
  const dangling = path.join(cwd, "seed.md");
  await symlink(path.join(outside, "never-created.txt"), dangling);

  await assert.rejects(createExclusive(dangling, "seed\n"), { code: "EEXIST" });
  assert.equal((await lstat(dangling)).isSymbolicLink(), true, "the link node is left for the caller to handle");
  await assert.rejects(readFile(path.join(outside, "never-created.txt"), "utf8"), { code: "ENOENT" });
});

test("ensureRealDir removes a symlinked path component instead of building through it", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-dir");
  await mkdir(victimDir);
  await writeFile(path.join(victimDir, "keep.txt"), SECRET);
  await symlink(victimDir, path.join(cwd, ".claude"));

  const made = await ensureRealDir(cwd, ".claude", "skills");

  assert.equal(made, path.join(cwd, ".claude", "skills"));
  assert.equal((await lstat(path.join(cwd, ".claude"))).isDirectory(), true);
  assert.equal((await lstat(path.join(cwd, ".claude"))).isSymbolicLink(), false);
  assert.deepEqual(await readdir(victimDir), ["keep.txt"], "the host directory keeps its contents");
});

test("ensureRealDir keeps an operator symlink that stays inside the channel's own folder", async (t) => {
  // A CUSTOM working folder is the operator's real project (a dotfiles repo, a monorepo package),
  // where `.claude -> packages/app/.claude` is deliberate layout, not an attack. Deleting every
  // non-directory node silently mangled those trees. A link is accepted only while it resolves to
  // a real directory still under the root the caller passed.
  const { cwd } = await scratch(t);
  const realHome = path.join(cwd, "packages", "app", "dot-claude");
  await mkdir(realHome, { recursive: true });
  await writeFile(path.join(realHome, "own.txt"), "operator content\n");
  await symlink(realHome, path.join(cwd, ".claude"));

  const made = await ensureRealDir(cwd, ".claude", "skills");

  assert.equal((await lstat(path.join(cwd, ".claude"))).isSymbolicLink(), true, "the link is preserved");
  // realpath, because macOS resolves the scratch dir through /private.
  assert.equal(made, path.join(await realpath(realHome), "skills"), "and the build continues below its target");
  assert.equal((await lstat(made)).isDirectory(), true);
  assert.deepEqual((await readdir(realHome)).sort(), ["own.txt", "skills"], "nothing of the operator's is lost");
});

test("ensureRealDir still removes a symlink that dangles or escapes the root", async (t) => {
  const { cwd, outside } = await scratch(t);
  const dangling = path.join(cwd, "gone");
  await symlink(path.join(outside, "never-created"), dangling);
  await ensureRealDir(cwd, "gone", "skills");
  assert.equal((await lstat(dangling)).isSymbolicLink(), false, "a dangling link is replaced by a real dir");
  // The escaping case is covered by the test above this pair (.claude -> outside/host-dir).
});

// ── channel-memory sinks ──────────────────────────────────────────────────────

test("channel memory provisioning does not follow a symlinked skills path or MEMORY.md", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-skills");
  await mkdir(victimDir);
  await symlink(victimDir, path.join(cwd, ".claude"));
  const indexVictim = await plantFileLink(path.join(cwd, memory.MEM_FILE), outside, "index-secrets.txt");

  await memory.applyChannelMemory(cwd, { memory: true });

  assert.deepEqual(await readdir(victimDir), [], "nothing was written into the host directory");
  const skillMd = path.join(cwd, ".claude", "skills", "channel-memory", "SKILL.md");
  assert.match(await readFile(skillMd, "utf8"), /name: channel-memory/);
  // The index seed must not be drawn through the planted link — its target stays untouched.
  assert.equal(await readFile(indexVictim, "utf8"), SECRET);
});

test("memory index writes replace a planted symlink instead of writing through it", async (t) => {
  const { cwd, outside } = await scratch(t);
  const memPath = path.join(cwd, memory.MEM_FILE);
  const victim = await plantFileLink(memPath, outside, "host-notes.md");

  const res = await memory.updateChannelMemory(cwd, {}, { action: "add", text: "Deploys run on Fridays." });

  await assertReplacedNode(memPath, victim);
  assert.equal(res.path, memPath);
  assert.match(await readFile(memPath, "utf8"), /Deploys run on Fridays\./);
  // A symlinked index reads as absent, so the foreign content never leaks into the new index.
  assert.doesNotMatch(await readFile(memPath, "utf8"), /SECRET-HOST-BYTES/);
  assert.deepEqual((await readdir(cwd)).filter((n) => n.endsWith(".tmp")), [], "the temp file is renamed, never left behind");
});

test("write_topic replaces a planted symlink at memory/<topic>.md and a symlinked memory/ dir", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-memory");
  await mkdir(victimDir);
  await writeFile(path.join(victimDir, "acme.md"), SECRET);
  await symlink(victimDir, path.join(cwd, memory.MEM_DIR));

  const res = await memory.updateChannelMemory(cwd, {}, { action: "write_topic", topic: "acme", content: "CSV import quirks" });

  assert.equal(res.path, path.join(cwd, memory.MEM_DIR, "acme.md"));
  assert.equal((await lstat(path.join(cwd, memory.MEM_DIR))).isSymbolicLink(), false);
  assert.equal(await readFile(res.path, "utf8"), "CSV import quirks\n");
  assert.equal(await readFile(path.join(victimDir, "acme.md"), "utf8"), SECRET, "the host topic file is untouched");
});

test("write_topic rejects a raw topic that slugify would silently rename to id-unknown", async (t) => {
  const { cwd } = await scratch(t);
  const write = (topic) => memory.updateChannelMemory(cwd, {}, { action: "write_topic", topic, content: "body" });

  for (const topic of ["", "   ", "../..", "...", "###", "-_-"]) {
    await assert.rejects(write(topic), /needs a topic name|no usable characters/, `topic ${JSON.stringify(topic)} must be refused`);
  }
  // Nothing was created under a fallback name.
  await assert.rejects(readdir(path.join(cwd, memory.MEM_DIR)), { code: "ENOENT" });

  const ok = await write("Acme / CSV");
  assert.equal(path.basename(ok.path), "acme-csv.md");
});

// ── gateway-usage guide sink ──────────────────────────────────────────────────

test("the gateway-usage refresh replaces planted symlinks inside its own skill folder", async (t) => {
  const { cwd, outside } = await scratch(t);
  const skillDir = path.join(cwd, ".claude", "skills", "gateway-usage");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  // Marker present = the folder is ours to refresh; SKILL.md and a reference file are links.
  await writeFile(path.join(skillDir, ".gateway-usage-skill"), "");
  const skillVictim = await plantFileLink(path.join(skillDir, "SKILL.md"), outside, "host-skill.md");

  await guide.applyGatewayGuide(cwd);

  await assertReplacedNode(path.join(skillDir, "SKILL.md"), skillVictim);
  assert.match(await readFile(path.join(skillDir, "SKILL.md"), "utf8"), /name: gateway-usage/);
});

test("the gateway-usage refresh rebuilds a symlinked .claude/skills path as real directories", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-skills");
  await mkdir(victimDir);
  await symlink(victimDir, path.join(cwd, ".claude"));

  await guide.applyGatewayGuide(cwd);

  assert.deepEqual(await readdir(victimDir), [], "nothing was written into the host directory");
  assert.equal((await lstat(path.join(cwd, ".claude"))).isSymbolicLink(), false);
  assert.match(await readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "SKILL.md"), "utf8"), /name: gateway-usage/);
});

// ── instruction files (folders.js) ────────────────────────────────────────────

test("the legacy CLAUDE.md migration removes a hostile symlink without reading through it", async (t) => {
  const slug = "symlink-migration-probe";
  const cwd = paths.workspaceFolder(slug);
  const outside = await mkdtemp(path.join(os.tmpdir(), "cg-outside-"));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(cwd, { recursive: true });

  // Hostile shape: an ABSOLUTE link out of the workspace, not the legacy relative "AGENTS.md".
  const victim = await plantFileLink(path.join(cwd, "CLAUDE.md"), outside, "id_rsa");

  await folders.ensureChannelFolder(slug, { allowedMcps: [] });

  const claude = await readFile(path.join(cwd, "CLAUDE.md"), "utf8");
  assert.equal(await readFile(victim, "utf8"), SECRET, "the host file is untouched");
  assert.equal((await lstat(path.join(cwd, "CLAUDE.md"))).isSymbolicLink(), false);
  assert.doesNotMatch(claude, /SECRET-HOST-BYTES/, "the hostile link's content is never carried into the workspace");
});

test("the legacy CLAUDE.md -> AGENTS.md mirror still migrates its content", async (t) => {
  const slug = "legacy-migration-probe";
  const cwd = paths.workspaceFolder(slug);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "AGENTS.md"), "# Channel rules\n\nAlways answer in Romanian.\n");
  await symlink("AGENTS.md", path.join(cwd, "CLAUDE.md")); // exactly the shape the gateway created

  await folders.ensureChannelFolder(slug, { allowedMcps: [] });

  const claude = await readFile(path.join(cwd, "CLAUDE.md"), "utf8");
  assert.equal((await lstat(path.join(cwd, "CLAUDE.md"))).isSymbolicLink(), false);
  assert.match(claude, /Always answer in Romanian\./);
  assert.equal(await readFile(path.join(cwd, "AGENTS.md"), "utf8"), claude, "AGENTS.md now mirrors CLAUDE.md");
});

test("update_channel_instructions never writes through an agent-planted symlink", async (t) => {
  const slug = "instructions-symlink-probe";
  const cwd = paths.workspaceFolder(slug);
  const outside = await mkdtemp(path.join(os.tmpdir(), "cg-outside-"));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(cwd, { recursive: true });
  const victim = await plantFileLink(path.join(cwd, "CLAUDE.md"), outside, ".zshrc");

  await folders.updateChannelInstructions(slug, { allowedMcps: [] }, { text: "Never post on Fridays." });

  await assertReplacedNode(path.join(cwd, "CLAUDE.md"), victim);
  assert.match(await readFile(path.join(cwd, "CLAUDE.md"), "utf8"), /Never post on Fridays\./);
});

// ── attachment sinks ──────────────────────────────────────────────────────────

function slackResponse(bytes, { contentType = "application/octet-stream", contentLength = null } = {}) {
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== null) headers.set("content-length", String(contentLength));
  return new Response(bytes, { status: 200, headers });
}

// Swap global.fetch for the duration of one test.
function stubFetch(t, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = real;
  });
}

test("same-named Slack attachments from different messages get distinct paths", async (t) => {
  const { cwd } = await scratch(t);
  stubFetch(t, async (url) => slackResponse(Buffer.from(`bytes for ${url}\n`)));

  const saved = await pipeline.downloadSlackFiles(
    [
      { id: "F001", name: "report.pdf", url_private_download: "https://files.slack.test/F001" },
      { id: "F002", name: "report.pdf", url_private_download: "https://files.slack.test/F002" },
    ],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000100" },
  );

  const paths_ = saved.map((s) => s.path);
  assert.equal(new Set(paths_).size, 2, "two different Slack files must not share a path");
  assert.equal(path.basename(paths_[0]), "F001-report.pdf");
  assert.equal(path.basename(paths_[1]), "F002-report.pdf");
  assert.equal(await readFile(paths_[0], "utf8"), "bytes for https://files.slack.test/F001\n");
  assert.equal(await readFile(paths_[1], "utf8"), "bytes for https://files.slack.test/F002\n");
});

test("Slack attachment downloads never write through a planted uploads symlink", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-uploads");
  await mkdir(victimDir);
  await writeFile(path.join(victimDir, "keep.txt"), SECRET);
  await symlink(victimDir, path.join(cwd, "uploads"));
  stubFetch(t, async () => slackResponse(Buffer.from("real attachment bytes\n")));

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F009", name: "notes.txt", url_private_download: "https://files.slack.test/F009" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000200" },
  );

  assert.equal((await lstat(path.join(cwd, "uploads"))).isSymbolicLink(), false);
  assert.deepEqual(await readdir(victimDir), ["keep.txt"], "the host directory is untouched");
  assert.equal(await readFile(saved.path, "utf8"), "real attachment bytes\n");
});

test("Slack attachment downloads enforce the byte cap on the STREAM, not the declared size", async (t) => {
  const { cwd } = await scratch(t);
  const oversized = Buffer.alloc(3 * 1024 * 1024, 0x41);
  // Slack (or a compromised URL) declares a tiny body and then streams 3 MB past a 2 MB cap.
  stubFetch(t, async () => slackResponse(oversized, { contentLength: 12 }));

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F010", name: "huge.bin", size: 12, url_private_download: "https://files.slack.test/F010" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000300", maxBytes: 2 * 1024 * 1024 },
  );

  assert.equal(saved.path, undefined);
  assert.match(saved.skipped, /exceeds the 2 MB attachment limit/);
  // The partial temp file is gone: nothing of the cut-off body survives in the thread folder.
  assert.deepEqual(await readdir(path.join(cwd, "uploads", "1700000000.000300")), []);
});

test("an attachment Slack declares over the cap is refused by NAME and SIZE before any bytes move", async (t) => {
  const { cwd } = await scratch(t);
  let fetched = 0;
  stubFetch(t, async () => { fetched += 1; return slackResponse(Buffer.alloc(16)); });

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F011", name: "CleanShot.mp4", size: 263.4 * 1024 * 1024, url_private_download: "https://files.slack.test/F011" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000301", maxBytes: 100 * 1024 * 1024 },
  );

  assert.equal(fetched, 0, "a declared oversize is an early reject — no request is made");
  assert.equal(saved.skipped, "263.4 MB exceeds the 100 MB attachment limit");
  // The production cap is the shared constant: 500 MB, and a 263 MB recording fits under it.
  assert.equal(ATTACHMENT_MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(pipeline.shouldAnnounceDownload([{ size: 9 * 1024 * 1024 }]), true);
  assert.equal(pipeline.shouldAnnounceDownload([{ size: 1024 }, { name: "x" }]), false);
});

test("Slack attachments stream to disk in chunks — the file is complete and never buffered whole", async (t) => {
  const { cwd } = await scratch(t);
  const chunks = [Buffer.alloc(1024 * 1024, 0x61), Buffer.alloc(1024 * 1024, 0x62), Buffer.from("tail")];
  let handedOut = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (handedOut < chunks.length) controller.enqueue(chunks[handedOut++]);
      else controller.close();
    },
  });
  stubFetch(t, async () => new Response(body, { status: 200, headers: { "content-type": "video/mp4" } }));

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F012", name: "clip.mp4", size: 2 * 1024 * 1024 + 4, url_private_download: "https://files.slack.test/F012" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000302" },
  );

  assert.equal(handedOut, chunks.length, "every chunk was pulled through the stream");
  assert.equal(saved.bytes, 2 * 1024 * 1024 + 4);
  assert.equal((await stat(saved.path)).size, 2 * 1024 * 1024 + 4);
  assert.deepEqual(await readdir(path.dirname(saved.path)), ["F012-clip.mp4"], "no temp file is left behind");
});

test("a streamed body that turns out to be Slack's HTML sign-in page is refused before it is committed", async (t) => {
  const { cwd } = await scratch(t);
  stubFetch(t, async () => slackResponse(Buffer.from("<!DOCTYPE html><html><body>sign in</body></html>"), { contentType: "application/octet-stream" }));

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F013", name: "report.pdf", url_private_download: "https://files.slack.test/F013" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000303" },
  );

  assert.equal(saved.path, undefined);
  assert.match(saved.skipped, /files:read scope/);
  assert.deepEqual(await readdir(path.join(cwd, "uploads", "1700000000.000303")), []);
});

test("the platform attachment sink streams a Response under the cap and names an oversize refusal", async () => {
  const message = {
    platform: "teams",
    threadKey: "19:thread@thread.tacv2",
    attachments: [
      { name: "plan.pdf", download: async () => new Response(Buffer.from("plan bytes\n"), { status: 200 }) },
      { name: "huge.mov", download: async () => new Response(Buffer.alloc(3 * 1024 * 1024), { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }) },
      { name: "buffered.txt", download: async () => Buffer.from("buffer bytes\n") },
    ],
  };
  const { paths: got, skipped } = await attachments.saveInboundAttachments(message, {
    slug: "teams-fixture",
    meta: { platform: "teams" }, // the default folder for the slug lives under the scratch workspace root
    log: { warn() {} },
    maxBytes: 2 * 1024 * 1024,
  });

  assert.equal(got.length, 2);
  assert.equal(await readFile(got[0], "utf8"), "plan bytes\n");
  assert.equal(await readFile(got[1], "utf8"), "buffer bytes\n");
  assert.deepEqual(skipped, ["huge.mov (3 MB exceeds the 2 MB attachment limit)"]);
  assert.deepEqual((await readdir(path.dirname(got[0]))).sort(), ["1-plan.pdf", "3-buffered.txt"]);
});

test("boundedResponseBytes stops an oversized body that under-declares content-length", async () => {
  const oversized = slackResponse(Buffer.alloc(64, 0x42), { contentLength: 4 });
  await assert.rejects(apiRuns.boundedResponseBytes(oversized, 16), /exceeds/);
});

test("writeStreamNoFollow cuts an over-cap stream, removes its temp file and never touches the destination", async (t) => {
  const { cwd } = await scratch(t);
  const dest = path.join(cwd, "keep.bin");
  await writeFile(dest, "previous content\n");
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(writeStreamNoFollow(dest, new Response(body), { maxBytes: 10 }), (err) => err.code === "ETOOLARGE" && /exceeds the 10 B attachment limit/.test(err.message));
  assert.equal(cancelled, true, "the connection is cancelled the moment the cap is passed");
  assert.equal(await readFile(dest, "utf8"), "previous content\n");
  assert.deepEqual(await readdir(cwd), ["keep.bin"], "no temp file remains");

  // A declared Content-Length over the cap is refused before a byte is read.
  let bodyTouched = false;
  const declared = { headers: new Headers({ "content-length": "11" }), get body() { bodyTouched = true; throw new Error("no"); } };
  await assert.rejects(writeStreamNoFollow(dest, declared, { maxBytes: 10 }), /11 B exceeds the 10 B attachment limit/);
  assert.equal(bodyTouched, false);
});

test("the API attachment sink rebuilds a symlinked uploads path and writes a real file", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-uploads");
  await mkdir(victimDir);
  await symlink(victimDir, path.join(cwd, "uploads"));

  const dest = await apiRuns.saveAttachment({
    cwd,
    jobId: "job123",
    file: { name: "payload.txt", dataBase64: Buffer.from("api bytes\n").toString("base64") },
  });

  assert.equal(dest, path.join(cwd, "uploads", "api_job123", "payload.txt"));
  assert.equal((await lstat(path.join(cwd, "uploads"))).isSymbolicLink(), false);
  assert.deepEqual(await readdir(victimDir), [], "the host directory is untouched");
  assert.equal(await readFile(dest, "utf8"), "api bytes\n");
});

test("the API attachment sink replaces a symlink planted at the destination name", async (t) => {
  const { cwd, outside } = await scratch(t);
  const destDir = path.join(cwd, "uploads", "api_job456");
  const victim = await plantFileLink(path.join(destDir, "payload.txt"), outside, "host-payload.txt");

  const dest = await apiRuns.saveAttachment({
    cwd,
    jobId: "job456",
    file: { name: "payload.txt", dataBase64: Buffer.from("api bytes\n").toString("base64") },
  });

  await assertReplacedNode(dest, victim);
  assert.equal(await readFile(dest, "utf8"), "api bytes\n");
});

// ── legacy library stubs ─────────────────────────────────────────────────────
// The retired Skills Manager integration left marker-bearing stub folders in older channel
// folders. Workspace provisioning prunes them (never a real skill folder), and does not follow a
// planted symlink while doing so.
test("leftover library stubs are pruned on workspace configure and real skill folders survive", async (t) => {
  const { cwd } = await scratch(t);
  const skills = path.join(cwd, ".claude", "skills");
  await mkdir(path.join(skills, "old-stub"), { recursive: true });
  await writeFile(path.join(skills, "old-stub", ".gateway-library-stub"), "");
  await writeFile(path.join(skills, "old-stub", "SKILL.md"), "stub\n");
  await mkdir(path.join(skills, "real-skill"), { recursive: true });
  await writeFile(path.join(skills, "real-skill", "SKILL.md"), "# real\n");
  assert.equal(await librarySkills.pruneLegacyLibraryStubs(skills), 1);
  await assert.rejects(lstat(path.join(skills, "old-stub")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(skills, "real-skill", "SKILL.md"), "utf8"), "# real\n");
  assert.equal(await librarySkills.pruneLegacyLibraryStubs(path.join(cwd, "nope")), 0);
});
