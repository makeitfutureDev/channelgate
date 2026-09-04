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
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile, symlink, lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
// Point the visible workspace root at scratch BEFORE importing anything that resolves it, so no
// test ever provisions a folder in the operator's real ~/Slack Agent.
process.env.CG_WORKSPACE_DIR ||= await mkdtemp(path.join(os.tmpdir(), "cg-ws-"));

const [{ readNoFollow, writeNoFollow, createExclusive, ensureRealDir }, memory, guide, folders, librarySkills, apiRuns, pipeline, paths] =
  await Promise.all([
    import("../src/gateway/safe-fs.js"),
    import("../src/gateway/channel-memory.js"),
    import("../src/gateway/guide.js"),
    import("../src/gateway/folders.js"),
    import("../src/gateway/library-skills.js"),
    import("../src/gateway/api-runs.js"),
    import("../src/slack/message-pipeline.js"),
    import("../src/config/paths.js"),
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
  const huge = Buffer.alloc(31 * 1024 * 1024, 0x41);
  // Slack (or a compromised URL) declares a tiny body and then streams 31MB.
  stubFetch(t, async () => slackResponse(huge, { contentLength: 12 }));

  const [saved] = await pipeline.downloadSlackFiles(
    [{ id: "F010", name: "huge.bin", size: 12, url_private_download: "https://files.slack.test/F010" }],
    "xoxb-test",
    { root: cwd, sub: "1700000000.000300" },
  );

  assert.equal(saved.path, undefined);
  assert.match(saved.skipped, /exceeds the 30MB limit/);
  await assert.rejects(readdir(path.join(cwd, "uploads", "1700000000.000300")), { code: "ENOENT" });
});

test("boundedResponseBytes stops an oversized body that under-declares content-length", async () => {
  const oversized = slackResponse(Buffer.alloc(64, 0x42), { contentLength: 4 });
  await assert.rejects(apiRuns.boundedResponseBytes(oversized, 16), /exceeds/);
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

// ── library stub frontmatter ──────────────────────────────────────────────────

// Minimal single-quoted YAML scalar reader: the value runs to the first quote that is not doubled.
function readSingleQuoted(line) {
  const body = line.replace(/^description: /, "");
  assert.equal(body.startsWith("'") && body.endsWith("'"), true, `not a single-quoted scalar: ${line}`);
  return body.slice(1, -1).replace(/''/g, "'");
}

test("library stub frontmatter quotes the remote description so it cannot restructure the YAML", async () => {
  const hostile = [
    "Use when: the user asks # anything",
    "[not, a, list] {nor: a map}",
    "it's the user's own words",
    "line one\nname: hijacked\ndescription: replaced",
    "*alias &anchor | folded > text",
  ];

  for (const description of hostile) {
    const md = librarySkills.libraryStubSkillMd("demo-skill", "Demo Skill", description);
    const lines = md.split("\n");
    assert.equal(lines[0], "---");
    assert.equal(lines[1], "name: demo-skill");
    assert.equal(lines[3], "---", `frontmatter must stay exactly two keys for ${JSON.stringify(description)}`);
    assert.equal(readSingleQuoted(lines[2]), description.replace(/\s+/g, " ").trim());
  }
});

test("library stubs land as real files even when the skill folder path is a symlink", async (t) => {
  const { cwd, outside } = await scratch(t);
  const victimDir = path.join(outside, "host-skills");
  await mkdir(victimDir);
  await symlink(victimDir, path.join(cwd, ".claude"));

  // Empty token → prune-only path, which must still not traverse the planted link.
  await librarySkills.applyLibrarySkills(cwd, "");

  assert.equal((await lstat(path.join(cwd, ".claude"))).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(cwd, ".claude", "skills"))).isDirectory(), true);
  assert.deepEqual(await readdir(victimDir), []);
});
