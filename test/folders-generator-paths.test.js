// Generator paths the settings-floor gate must keep reached: work-folder containment
// (effectiveWorkDir), the channel-owned instruction section (updateChannelInstructions), and the
// skill listing / host-folder grant fallback (listAvailableSkills, skillSourceDirs, enableSkills).
// These are the functions the 2026-09-04 skills-catalog change added or reshaped in folders.js;
// without them the security-coverage ratchet for the settings generator falls below its floor.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

ensureTestEnv();
// This test checks custom paths under the account's allowed root, regardless of a developer's
// CG_FS_ROOT override. Its disposable projects are grouped below that home instead of beside it.
process.env.CG_FS_ROOT = os.homedir();

const [
  { effectiveWorkDir, createWorkDirResolver, updateChannelInstructions, listAvailableSkills, skillSourceDirs, enableSkills, splitGatewayBlock, gatewayInstructionsBlock, channelSwitchesNote },
  { workspaceFolder, cleanWorkspaceFolder },
  { allowedFsRoot },
] = await Promise.all([
  import("../src/gateway/folders.js"),
  import("../src/config/paths.js"),
  import("../src/web/security.js"),
]);

// Custom workDirs must live under the allowed filesystem root. Keep this test's disposable
// projects together instead of scattering cg-* directories across the operator's home.
const fixtureParent = path.join(allowedFsRoot(), "ChannelGate Testing");
mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
const fixtureRoot = trackTempDir(mkdtempSync(path.join(fixtureParent, "folders-generator-")));

test("a snapshot work-folder resolver decides exactly what effectiveWorkDir decides", () => {
  const project = mkdtempSync(path.join(fixtureRoot, "cg-resolver-"));
  const origin = workspaceFolder("resolver-origin", "slack");
  mkdirSync(origin, { recursive: true });
  const outside = trackTempDir(mkdtempSync(path.join(os.tmpdir(), "cg-resolver-escape-")));
  const cases = [
    ["resolver-a", {}],
    ["resolver-a", { platform: "msteams" }],
    ["resolver-a", { cleanMode: true }],
    ["resolver-a", { cleanMode: true, workDir: project }],
    ["resolver-a", { workDir: project }],
    ["resolver-b", { workDir: project }],
    ["resolver-a", { workDir: ` ${project} ` }],
    ["resolver-a", { workDir: path.join(project, "gone") }],
    ["resolver-a", { workDir: outside }],
    ["resolver-a", { workDir: os.homedir() }],
    ["resolver-a", { workDir: "relative/path" }],
    // An origin's default folder is honoured only for the conversation that names that origin.
    ["resolver-code", { workDir: origin }],
    ["resolver-code", { workDir: origin, workspaceOwnerSlug: "resolver-origin" }],
    ["resolver-code", { workDir: origin, codeChannel: { originSlug: "resolver-origin" } }],
    ["resolver-code", { workDir: origin, workspaceOrigin: { slug: "resolver-origin", platform: "slack" } }],
    ["resolver-code", { workDir: origin, workspaceOrigin: { slug: "resolver-origin", platform: "msteams" } }],
    ["resolver-code", { workDir: origin, workspaceOrigin: { slug: "resolver-other", platform: "slack" } }],
    ["resolver-code", { workDir: origin, workspaceOwnerSlug: "resolver-origin", workspaceLink: { platform: "msteams" } }],
  ];
  const original = console.warn;
  console.warn = () => {};
  try {
    const resolve = createWorkDirResolver();
    // Asked twice and in both orders: an earlier answer must never leak into a different question.
    for (const [slug, meta] of [...cases, ...cases.toReversed()]) {
      assert.equal(resolve(slug, meta), effectiveWorkDir(slug, meta), `${slug} ${JSON.stringify(meta)}`);
    }
    assert.equal(resolve("resolver-default"), effectiveWorkDir("resolver-default"));
  } finally {
    console.warn = original;
  }
});

test("a work-folder resolver belongs to one snapshot: the next one observes changed directories and roots", () => {
  const slug = "resolver-fresh";
  const project = path.join(mkdtempSync(path.join(fixtureRoot, "cg-resolver-fresh-")), "later");
  const first = createWorkDirResolver();
  assert.equal(first(slug, { workDir: project }), workspaceFolder(slug, undefined), "not there yet: the default folder");
  mkdirSync(project);
  assert.equal(first(slug, { workDir: project }), workspaceFolder(slug, undefined), "one snapshot keeps one answer");
  assert.equal(createWorkDirResolver()(slug, { workDir: project }), project, "the next snapshot sees the directory");

  // The daemon-owned trees are observed per snapshot too: a folder that has become the gateway
  // runtime root is refused by the next resolver, not waved through from an earlier look.
  const previousGatewayRoot = process.env.CHANNELGATE_DIR;
  const quiet = console.warn;
  console.warn = () => {};
  process.env.CHANNELGATE_DIR = project;
  try {
    assert.equal(first(slug, { workDir: project }), workspaceFolder(slug, undefined));
    assert.equal(createWorkDirResolver()(slug, { workDir: project }), workspaceFolder(slug, undefined));
    assert.equal(effectiveWorkDir(slug, { workDir: project }), workspaceFolder(slug, undefined));
  } finally {
    process.env.CHANNELGATE_DIR = previousGatewayRoot;
    console.warn = quiet;
  }
  assert.equal(createWorkDirResolver()(slug, { workDir: project }), project);

  // Narrowing the allowlisted root takes effect for the next snapshot, like effectiveWorkDir.
  const held = createWorkDirResolver();
  assert.equal(held(slug, { workDir: project }), project);
  const previousRoot = process.env.CG_FS_ROOT;
  const original = console.warn;
  console.warn = () => {};
  process.env.CG_FS_ROOT = trackTempDir(mkdtempSync(path.join(os.tmpdir(), "cg-resolver-root-")));
  try {
    assert.equal(createWorkDirResolver()(slug, { workDir: project }), workspaceFolder(slug, undefined));
    assert.equal(effectiveWorkDir(slug, { workDir: project }), workspaceFolder(slug, undefined));
  } finally {
    process.env.CG_FS_ROOT = previousRoot;
    console.warn = original;
  }
});

test("effectiveWorkDir: clean mode, a contained custom workDir, and an escaping one", () => {
  const slug = "workdir-probe";
  assert.equal(effectiveWorkDir(slug, { cleanMode: true }), cleanWorkspaceFolder(slug, undefined));

  // A stored absolute workDir inside the allowed root that exists is honoured as-is.
  const inside = mkdtempSync(path.join(fixtureRoot, "cg-workdir-"));
  assert.equal(effectiveWorkDir(slug, { workDir: inside }), inside);

  // The same path once it has vanished falls back to the default folder.
  const vanished = path.join(inside, "gone");
  assert.equal(effectiveWorkDir(slug, { workDir: vanished }), workspaceFolder(slug, undefined));

  // A workDir outside the allowed root is never honoured, even when the directory exists.
  const outside = mkdtempSync(path.join(os.tmpdir(), "cg-escape-"));
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.equal(effectiveWorkDir(slug, { workDir: outside }), workspaceFolder(slug, undefined));
    assert.equal(effectiveWorkDir(slug, { workDir: outside }), workspaceFolder(slug, undefined));
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => w.includes("escapes the allowed root")), "the escape is logged, not silent");
  // Every channel listing resolves every channel through here: the warning is once per channel
  // and value, not once per lookup.
  assert.equal(warnings.filter((w) => w.includes("escapes the allowed root")).length, 1, "a stale workDir is reported once, not on every lookup");
  assert.equal(effectiveWorkDir(slug, { workDir: "relative/path" }), workspaceFolder(slug, undefined));
});

test("updateChannelInstructions keeps the managed block on a default folder and never injects one elsewhere", async () => {
  const slug = "instructions-probe";
  const meta = { name: "Instructions probe", allowedMcps: [] };
  const first = await updateChannelInstructions(slug, meta, { text: "Always answer in Romanian.\n\n" });
  assert.equal(first.path, path.join(workspaceFolder(slug, undefined), "CLAUDE.md"));
  let content = readFileSync(first.path, "utf8");
  assert.equal(splitGatewayBlock(content).found, true, "a default folder carries the managed block");
  assert.match(content, /Always answer in Romanian\.\n$/);

  await updateChannelInstructions(slug, meta, { text: "Never paste secrets." });
  content = readFileSync(first.path, "utf8");
  assert.match(content, /Always answer in Romanian\.\n\nNever paste secrets\.\n$/, "append keeps the earlier rule");

  await updateChannelInstructions(slug, meta, { text: "Only this rule.", replace: true });
  content = readFileSync(first.path, "utf8");
  assert.equal(splitGatewayBlock(content).found, true, "replace keeps the managed block");
  assert.doesNotMatch(content, /Romanian/);
  assert.match(content, /Only this rule\.\n$/);

  // Custom project folder: the file's own content is edited, no block is added.
  const custom = mkdtempSync(path.join(fixtureRoot, "cg-custom-"));
  const customMeta = { ...meta, workDir: custom };
  await updateChannelInstructions(slug, customMeta, { text: "Project rule one." });
  await updateChannelInstructions(slug, customMeta, { text: "Project rule two." });
  const customContent = readFileSync(path.join(custom, "CLAUDE.md"), "utf8");
  assert.equal(splitGatewayBlock(customContent).found, false);
  assert.equal(customContent, "Project rule one.\n\nProject rule two.\n");

  // A project that keeps AGENTS.md as the real file with the gateway's mirror link on CLAUDE.md
  // is edited through the link's exact sibling shape only.
  const mirrored = mkdtempSync(path.join(fixtureRoot, "cg-mirror-"));
  writeFileSync(path.join(mirrored, "AGENTS.md"), "# Project\n");
  const { symlinkSync } = await import("node:fs");
  symlinkSync("AGENTS.md", path.join(mirrored, "CLAUDE.md"));
  const written = await updateChannelInstructions(slug, { ...meta, workDir: mirrored }, { text: "Mirror rule." });
  assert.equal(written.path, path.join(mirrored, "AGENTS.md"));
  assert.equal(readFileSync(path.join(mirrored, "AGENTS.md"), "utf8"), "# Project\n\nMirror rule.\n");
  assert.equal(lstatSync(path.join(mirrored, "CLAUDE.md")).isSymbolicLink(), true, "the mirror link is left alone");
  assert.equal(readlinkSync(path.join(mirrored, "CLAUDE.md")), "AGENTS.md");
});

test("skill listing unions the catalog with the host folders, and a host-folder grant still materialises", async () => {
  const sources = mkdtempSync(path.join(os.tmpdir(), "cg-skill-sources-"));
  const hostSkill = path.join(sources, "host-only-skill");
  mkdirSync(hostSkill);
  writeFileSync(path.join(hostSkill, "SKILL.md"), "---\nname: host-only-skill\ndescription: from the host folder\n---\n# Host only\n");
  const previous = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = `${sources}:${path.join(sources, "absent")}`;
  try {
    assert.deepEqual(skillSourceDirs(), [sources, path.join(sources, "absent")]);
    const names = await listAvailableSkills();
    assert.ok(names.includes("host-only-skill"), "host folder skills are listed");
    assert.deepEqual(names, [...names].sort(), "listing is sorted");

    const skillsDir = path.join(mkdtempSync(path.join(os.tmpdir(), "cg-skills-dir-")), ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const result = await enableSkills(skillsDir, ["host-only-skill", "no-such-skill-anywhere", "../escape"]);
    assert.ok(result.enabled.includes("host-only-skill"), "a grant absent from the catalog falls back to the host copy");
    assert.ok(existsSync(path.join(skillsDir, "host-only-skill", "SKILL.md")));
    assert.ok(result.missing.includes("no-such-skill-anywhere"), "an unknown grant is reported, never dropped");
    assert.equal(Object.hasOwn(result.states, "no-such-skill-anywhere"), true);
    assert.equal(existsSync(path.join(skillsDir, "..", "escape")), false, "a traversal grant is sanitised away");

    // Revoking the grant removes the managed copy; a project-owned folder of another name stays.
    mkdirSync(path.join(skillsDir, "project-owned"));
    writeFileSync(path.join(skillsDir, "project-owned", "SKILL.md"), "# mine\n");
    const revoked = await enableSkills(skillsDir, []);
    assert.deepEqual(revoked.enabled, []);
    assert.equal(existsSync(path.join(skillsDir, "host-only-skill")), false, "the managed copy is pruned with its grant");
    assert.ok(existsSync(path.join(skillsDir, "project-owned", "SKILL.md")), "project-owned folders are never touched");
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_SKILL_SOURCES;
    else process.env.GATEWAY_SKILL_SOURCES = previous;
  }
});

test("a custom project folder gets a real CLAUDE.md with AGENTS.md mirrored, and a renamed managed skill folder is migrated", async () => {
  const { ensureChannelFolder } = await import("../src/gateway/folders.js");
  const { MANAGED_SKILL_MARKER } = await import("../src/gateway/skills/materialize.js");
  const custom = mkdtempSync(path.join(fixtureRoot, "cg-project-"));
  const slug = "custom-project-probe";
  await ensureChannelFolder(slug, { name: "Custom project", workDir: custom, allowedMcps: [], instructions: "Project instructions from the channel record." });
  const claude = path.join(custom, "CLAUDE.md");
  const agents = path.join(custom, "AGENTS.md");
  assert.equal(lstatSync(claude).isFile(), true, "the custom folder's CLAUDE.md is a real file");
  assert.match(readFileSync(claude, "utf8"), /Project instructions from the channel record\./);
  assert.equal(splitGatewayBlock(readFileSync(claude, "utf8")).found, false, "no managed block in a project folder");
  assert.equal(lstatSync(agents).isSymbolicLink(), true);
  assert.equal(readlinkSync(agents), "CLAUDE.md");

  // A workspace materialised before the product rename still holds the old bundled skill folder
  // under its old name, marker and all. The obsolete copy is pruned; unselected hand-made copies are archived.
  const skillsDir = path.join(custom, ".claude", "skills");
  mkdirSync(path.join(skillsDir, "claude-gateway"), { recursive: true });
  writeFileSync(path.join(skillsDir, "claude-gateway", MANAGED_SKILL_MARKER), "");
  writeFileSync(path.join(skillsDir, "claude-gateway", "SKILL.md"), "# old name\n");
  mkdirSync(path.join(skillsDir, "hand-made"), { recursive: true });
  writeFileSync(path.join(skillsDir, "hand-made", "SKILL.md"), "# mine\n");
  await ensureChannelFolder(slug, { name: "Custom project", workDir: custom, allowedMcps: [] });
  assert.equal(existsSync(path.join(skillsDir, "claude-gateway")), false, "the old managed folder is gone");
  assert.equal(existsSync(path.join(skillsDir, "hand-made")), false, "unselected local skills are archived outside discovery");
});

// ── A repository work folder: the gateway-assembled CLAUDE.md ─────────────────
// On 2026-11-20 a whole-file "replace" of a repository channel's instructions overwrote the
// tracked 746-line AGENTS.md with two bullets, because the channel's rules lived as an uncommitted
// tail of that tracked file. A repository folder whose CLAUDE.md is untracked now gets an
// untracked, git-excluded CLAUDE.md the gateway assembles (guide + AGENTS.local.md + the channel's
// own section) and an AGENTS.override.md link for Codex; the tracked AGENTS.md is never written.
const { execFileSync } = await import("node:child_process");
const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
function repoFixture(prefix, { trackClaudeLink = false } = {}) {
  const repo = mkdtempSync(path.join(fixtureRoot, prefix));
  gitIn(repo, "init", "-q");
  writeFileSync(path.join(repo, "AGENTS.md"), "# Project guide\n\nAlways run the tests.\n");
  if (trackClaudeLink) symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md"));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "init");
  return repo;
}
const { symlinkSync } = await import("node:fs");

test("a repository folder gets an untracked assembled CLAUDE.md; the tracked guide is never written", async () => {
  const { ensureChannelFolder, splitProjectBlock } = await import("../src/gateway/folders.js");
  const repo = repoFixture("cg-repo-");
  writeFileSync(path.join(repo, "AGENTS.local.md"), "# Private\n\nPush as the deploy account.\n");
  symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md")); // the old mirror link, untracked
  const slug = "repo-project-probe";
  const meta = { name: "Repo project", workDir: repo, allowedMcps: [] };
  await ensureChannelFolder(slug, meta);

  const claude = path.join(repo, "CLAUDE.md");
  const guideBefore = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  assert.equal(lstatSync(claude).isFile(), true, "CLAUDE.md is now a real, gateway-assembled file");
  let content = readFileSync(claude, "utf8");
  assert.equal(splitProjectBlock(content).found, true);
  assert.match(content, /Always run the tests\./, "carries the tracked guide");
  assert.match(content, /Push as the deploy account\./, "and the private AGENTS.local.md");
  assert.equal(readlinkSync(path.join(repo, "AGENTS.override.md")), "CLAUDE.md", "Codex reads the same file");
  assert.match(readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/CLAUDE\.md$/m);
  assert.match(readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/AGENTS\.override\.md$/m);

  await updateChannelInstructions(slug, meta, { text: "- Rule one." });
  await updateChannelInstructions(slug, meta, { text: "- Rule two." });
  content = readFileSync(claude, "utf8");
  assert.match(content, /<!-- PROJECT-INSTRUCTIONS:END -->\n\n- Rule one\.\n\n- Rule two\.\n$/);
  await updateChannelInstructions(slug, meta, { text: "- Only rule.", replace: true });
  content = readFileSync(claude, "utf8");
  assert.equal(splitProjectBlock(content).found, true, "replace keeps the project block");
  assert.match(content, /Always run the tests\./);
  assert.doesNotMatch(content, /Rule one/);
  assert.match(content, /- Only rule\.\n$/);
  assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), guideBefore, "the tracked guide is untouched");
  const status = gitIn(repo, "status", "--porcelain");
  assert.doesNotMatch(status, /CLAUDE\.md|AGENTS\.override\.md|AGENTS\.md$/m, "the assembled files stay out of git status and the guide is unmodified");

  // A landed change to the guide is picked up on the next run; the channel's rules survive it.
  writeFileSync(path.join(repo, "AGENTS.md"), "# Project guide\n\nAlways run the FULL tests.\n");
  await ensureChannelFolder(slug, meta);
  content = readFileSync(claude, "utf8");
  assert.match(content, /Always run the FULL tests\./);
  assert.match(content, /- Only rule\.\n$/);
});

test("a repository that tracks CLAUDE.md keeps its own files, and its tracked guide refuses a whole-file replace", async () => {
  const { ensureChannelFolder } = await import("../src/gateway/folders.js");
  const repo = repoFixture("cg-repo-tracked-", { trackClaudeLink: true });
  const slug = "repo-tracked-probe";
  const meta = { name: "Repo tracked", workDir: repo, allowedMcps: [] };
  await ensureChannelFolder(slug, meta);
  assert.equal(lstatSync(path.join(repo, "CLAUDE.md")).isSymbolicLink(), true, "the project's tracked link is left alone");
  assert.equal(existsSync(path.join(repo, "AGENTS.override.md")), false);
  await assert.rejects(updateChannelInstructions(slug, meta, { text: "- Wipe it.", replace: true }), /can only be appended/);
  assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "# Project guide\n\nAlways run the tests.\n", "the guide survives");
  await updateChannelInstructions(slug, meta, { text: "- Appended rule." });
  assert.match(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /Always run the tests\.\n\n- Appended rule\.\n$/, "append still works there");
});

// ── What the ENGINE is told about its own channel ─────────────────────────────
// Live QA (both engines): asked whether it was allowed on the network, a run answered that
// "nothing in my system context, channel instructions, or session config mentions it either way"
// — and it was right. CLAUDE.md is the file both harnesses read (Claude via
// --append-system-prompt-file, Codex via the AGENTS.md symlink), so the channel's own switches
// belong in its gateway-managed block.
test("the managed block states this conversation's mode and network switch, in both directions", async () => {
  const { NETWORK_ADVISORY_NOTE } = await import("../src/engines/network-policy.js");

  const off = channelSwitchesNote({ allowBash: true });
  assert.match(off, /Mode: \*\*worker\*\*/);
  assert.match(off, /Network: \*\*off\*\*/, "an off switch is SAID, not implied by silence");
  assert.match(off, /NOT meant to use the internet/);
  // Honest, not a lie the first successful request would expose: the container is not cut off.
  assert.ok(off.includes(NETWORK_ADVISORY_NOTE), "the advisory caveat is the shared phrase");
  assert.match(off, /that is not permission/i);

  const on = channelSwitchesNote({ autoMode: true, allowNetwork: true, engine: "claude" });
  assert.match(on, /Mode: \*\*worker\*\*/);
  assert.match(on, /Auto: \*\*on\*\*/);
  assert.match(on, /Network: \*\*on\*\*/);
  assert.doesNotMatch(on, /NOT meant to use the internet/);

  // And it actually rides the block every channel folder receives — clean mode included, since a
  // lean channel still has to know what it may do.
  for (const meta of [{ allowBash: true }, { allowBash: true, cleanMode: true }]) {
    const block = gatewayInstructionsBlock(meta);
    assert.equal(splitGatewayBlock(block).found, true);
    assert.match(block, /This conversation's switches/);
    assert.match(block, /Network: \*\*off\*\*/);
  }
});

// The retest wave of 2026-09-06: five cases kept failing on one engine because it never opened the
// `gateway-usage` skill body (the string appeared only in the skills catalog listing, and none of
// the new rule text appeared at all), while the other engine — reading the identical text through
// the AGENTS.md symlink — passed. A rule that only lands when a model chooses to read a skill is
// not a rule, so the irreducible core moved into the managed block, which is appended to the system
// prompt of every run. These anchors are what the failures cost us; if one disappears, the fix is
// gone and the failures come back.
//
// CO-02 (same wave) is the identity-SUBSTITUTION half: a requester with no personal Composio token
// asked for "my Gmail", and the run answered from the shared `composio-agent` identity — reporting
// a third employee's mailbox address and subject lines as the requester's own.
test("the managed block carries the hard rules a run must never get wrong", () => {
  for (const meta of [{ allowBash: true }, { allowBash: true, cleanMode: true }, { autoMode: true, allowNetwork: true }]) {
    const block = gatewayInstructionsBlock(meta);
    assert.equal(splitGatewayBlock(block).found, true);
    assert.match(block, /Hard rules \(not optional\)/);

    // 1. Unrestricted reads can use both identities; writes retain account selection.
    assert.match(block, /`composio-user`/);
    assert.match(block, /`composio-agent`/);
    assert.match(block, /Reads and searches may use either or\s+both identities without asking which account/);
    assert.match(block, /Writes require the intended identity and connected account/);

    // 2. A request phrased for the requester's OWN accounts is `composio-user` or nothing — the
    //    agent's shared identity is never substituted for a missing personal one (CO-02: a
    //    requester with no personal token asked for "my Gmail" and was told a third employee's
    //    mailbox identity and subject lines).
    assert.match(block, /"My X" is the requester's X/);
    assert.match(block, /served ONLY by `composio-user`/);
    assert.match(block, /do not read\n?\s*`composio-agent` to answer it/);
    assert.match(block, /may expose someone else's data/);
    assert.doesNotMatch(block, /holds OTHER people's|never the requester's/);
    assert.match(block, /Logical identities do not prove who owns/);
    assert.match(block, /not necessarily shared across channels/);
    // …and the mirror direction: "your X" must not be answered from the requester's identity.
    assert.match(block, /"the agent's X" never\n?\s*touches `composio-user`/);

    // 3. Inventory goes through the search tool; MANAGE_CONNECTIONS initiates and is not a
    //    read-only listing, whatever its action (CO-05: an "inventory" raised a pending auth).
    assert.match(block, /COMPOSIO_SEARCH_TOOLS/);
    assert.match(block, /COMPOSIO_MANAGE_CONNECTIONS/);
    assert.match(block, /any action, `list` included — INITIATES connections/);

    // 4. The harness's own backgrounding dies with the turn; only the daemon tools report back
    //    (ART-005 / AU-07 promised "I'll report back" from a harness background shell).
    assert.match(block, /never promise "I'll report back"/);
    assert.match(block, /`run_in_background`/);
    assert.match(block, /`run_agent_in_background`/);
    assert.match(block, /`create_schedule`/);
    // …and a FINITE repeat-check ("every 10 minutes, 6 times") is a schedule, not an in-turn poll
    //  loop the turn would have to stay alive for.
    assert.match(block, /A bounded "check every N minutes, K times"/);
    assert.match(block, /never an in-turn sleep\/poll loop/);

    // 5. No blanket container prune or reset, ever — in the block every run loads, not only in the
    //    skill (OPS-DISK-01: a Claude run never opened the skill and recommended `podman system prune`).
    //    The stated consequence must be TRUE for every command named (a model that knows podman can
    //    argue away a false one): not all of them touch volumes, but each can remove channel homes
    //    or the runtime image.
    assert.match(block, /Never run or recommend `podman system prune`\/`reset`/);
    for (const command of ["podman system prune", "podman image prune -a", "podman volume prune", "docker system prune"]) {
      assert.ok(block.includes(`\`${command}\``), `${command} is named whole, on one line`);
    }
    assert.match(block, /they can delete channel homes or the runtime image/);
    assert.doesNotMatch(block, /delete every channel's home/);
    // The admin-approved removal path stays open.
    assert.ok(block.includes("`npm run runtime:storage` (`-- --apply` only if an admin asks)"));

    // The header note keeps its three facts through any future squeeze for budget.
    assert.match(block, /do NOT edit between these markers/);
    assert.match(block, /never overwritten/);
    assert.match(block, /`update_channel_instructions`/);

    // Still the whole block, not a replacement for it: tonight's switches section survives.
    assert.match(block, /This conversation's switches/);
  }

  // Clean mode keeps the rules even though Composio may be absent there — the block says the rules
  // apply where the tools exist rather than pretending to know which ones this channel has.
  assert.match(gatewayInstructionsBlock({ cleanMode: true }), /wherever the named tools exist/);

  // Prompt weight is the price of always-on context: the gateway-owned part of the block (clean
  // mode = no admin global instructions) stays small enough to be READ rather than skimmed. If a
  // future rule needs more than this, it belongs in the skill, not here.
  const owned = gatewayInstructionsBlock({ allowBash: true, cleanMode: true });
  assert.ok(Buffer.byteLength(owned, "utf8") < 4096, `managed block is ${Buffer.byteLength(owned, "utf8")} bytes — keep it under 4 KB`);
  // The budget above is measured in one representative configuration. The longest switch lines
  // (Admin + Auto, Lean off) already push the worst case slightly past 4 KB; it must not grow.
  const keys = ["adminMode", "allowBash", "autoMode", "cleanMode", "allowNetwork", "isDM"];
  let worst = 0;
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const meta = Object.fromEntries(keys.map((key, i) => [key, Boolean(mask & (1 << i))]));
    worst = Math.max(worst, Buffer.byteLength(gatewayInstructionsBlock(meta), "utf8"));
  }
  assert.ok(worst <= 4120, `worst-case managed block is ${worst} bytes — it may shrink, never grow`);
});

// Security audit batch 5: the host-folder fallback used to copy with `dereference: true`, so a
// symlink INSIDE a skill folder copied any host file it pointed at into a channel folder (which
// the channel's container reads). The skill folder itself may still be a link into a store; a link
// inside it is followed only while its real target stays inside that skill's own real root.
test("host-folder skill copies follow only symlinks that stay inside the skill's real root", async (t) => {
  const { readSkillDirectory } = await import("../src/gateway/skills/import-folder.js");
  const base = trackTempDir(mkdtempSync(path.join(os.tmpdir(), "cg-skill-links-")));
  const store = path.join(base, "available_skills");
  const real = path.join(store, "linked-host-skill");
  mkdirSync(path.join(real, "references"), { recursive: true });
  writeFileSync(path.join(real, "SKILL.md"), "---\nname: linked-host-skill\ndescription: d\n---\n# Linked\n");
  writeFileSync(path.join(real, "references", "guide.md"), "inside");
  writeFileSync(path.join(real, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  // Legitimate: links that stay inside the skill (a file, a directory, a loop back to the root).
  symlinkSync("references/guide.md", path.join(real, "alias.md"));
  symlinkSync("references", path.join(real, "refs"));
  symlinkSync(".", path.join(real, "self"));
  // Hostile: a host secret, a sibling skill in the same store, a parent escape and a dangling link.
  const secret = path.join(base, "host-secret.txt");
  writeFileSync(secret, "TOP-SECRET-HOST-FILE");
  mkdirSync(path.join(store, "sibling"), { recursive: true });
  writeFileSync(path.join(store, "sibling", "private.md"), "SIBLING-ONLY");
  symlinkSync(secret, path.join(real, "leak.txt"));
  symlinkSync(path.join(base), path.join(real, "references", "up"));
  symlinkSync("../sibling/private.md", path.join(real, "borrowed.md"));
  symlinkSync(path.join(base, "nowhere"), path.join(real, "dangling.md"));
  const sources = path.join(base, "sources");
  mkdirSync(sources);
  symlinkSync(real, path.join(sources, "linked-host-skill")); // the skill folder itself is a link

  const previous = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = sources;
  t.after(() => { if (previous === undefined) delete process.env.GATEWAY_SKILL_SOURCES; else process.env.GATEWAY_SKILL_SOURCES = previous; });
  const warnings = [];
  const warn = t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });

  const hostile = ["leak.txt", "borrowed.md", "dangling.md", "references/up"];
  const check = (dir, label) => {
    assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8").includes("# Linked"), true, `${label}: the linked skill folder is copied`);
    assert.equal(readFileSync(path.join(dir, "alias.md"), "utf8"), "inside", `${label}: an internal file link is followed`);
    assert.equal(readFileSync(path.join(dir, "refs", "guide.md"), "utf8"), "inside", `${label}: an internal directory link is followed`);
    for (const rel of hostile) assert.equal(existsSync(path.join(dir, rel)), false, `${label}: ${rel} is not copied`);
  };

  // Non-authoritative fallback (cp replacement).
  const skillsDir = path.join(base, "chan", ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const result = await enableSkills(skillsDir, ["linked-host-skill"]);
  assert.ok(result.enabled.includes("linked-host-skill"));
  const dest = path.join(skillsDir, "linked-host-skill");
  check(dest, "fallback");
  assert.equal(lstatSync(path.join(dest, "run.sh")).mode & 0o111, 0o111, "the executable bit is kept");
  assert.equal(lstatSync(path.join(dest, "alias.md")).isSymbolicLink(), false, "copies are real files");
  for (const rel of hostile) assert.ok(warnings.some((w) => w.includes(rel) && w.includes("skipped symlink")), `a warning names ${rel}`);
  const copied = JSON.stringify(readdirRecursive(dest));
  assert.doesNotMatch(copied, /host-secret/);

  // Authoritative fallback (bundle read through readSkillDirectory).
  const authDir = path.join(base, "chan-auth", ".claude", "skills");
  mkdirSync(authDir, { recursive: true });
  const auth = await enableSkills(authDir, ["linked-host-skill"], { authoritative: true, backupDir: path.join(base, "backups") });
  assert.ok(auth.enabled.includes("linked-host-skill"));
  check(path.join(authDir, "linked-host-skill"), "authoritative");

  // The catalog import read (folder sources) applies the same rule.
  const skipped = [];
  const files = await readSkillDirectory(path.join(sources, "linked-host-skill"), { onSkip: (rel) => skipped.push(rel) });
  const paths = files.map((f) => f.path);
  for (const rel of hostile) assert.equal(paths.includes(rel), false, `import skips ${rel}`);
  assert.deepEqual(skipped.sort(), [...hostile, "refs/up"].sort(), "the escape is skipped on every path that reaches it");
  assert.ok(paths.includes("alias.md") && paths.includes("refs/guide.md"));
  assert.equal(files.some((f) => String(f.content).includes("TOP-SECRET") || String(f.content).includes("SIBLING-ONLY")), false);
  warn.mock.restore();
});

function readdirRecursive(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSyncTyped(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(rel);
    if (entry.isDirectory()) out.push(...readdirRecursive(path.join(dir, entry.name), rel));
  }
  return out;
}
function readdirSyncTyped(dir) {
  return readdirSync(dir, { withFileTypes: true });
}
