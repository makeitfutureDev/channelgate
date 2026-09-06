// Generator paths the settings-floor gate must keep reached: work-folder containment
// (effectiveWorkDir), the channel-owned instruction section (updateChannelInstructions), and the
// skill listing / host-folder grant fallback (listAvailableSkills, skillSourceDirs, enableSkills).
// These are the functions the 2026-09-04 skills-catalog change added or reshaped in folders.js;
// without them the security-coverage ratchet for the settings generator falls below its floor.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [
  { effectiveWorkDir, updateChannelInstructions, listAvailableSkills, skillSourceDirs, enableSkills, splitGatewayBlock, gatewayInstructionsBlock, channelSwitchesNote },
  { workspaceFolder, cleanWorkspaceFolder },
  { allowedFsRoot },
] = await Promise.all([
  import("../src/gateway/folders.js"),
  import("../src/config/paths.js"),
  import("../src/web/security.js"),
]);

test("effectiveWorkDir: clean mode, a contained custom workDir, and an escaping one", () => {
  const slug = "workdir-probe";
  assert.equal(effectiveWorkDir(slug, { cleanMode: true }), cleanWorkspaceFolder(slug, undefined));

  // A stored absolute workDir inside the allowed root that exists is honoured as-is.
  const inside = mkdtempSync(path.join(allowedFsRoot(), "cg-workdir-"));
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
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => w.includes("escapes the allowed root")), "the escape is logged, not silent");
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
  const custom = mkdtempSync(path.join(allowedFsRoot(), "cg-custom-"));
  const customMeta = { ...meta, workDir: custom };
  await updateChannelInstructions(slug, customMeta, { text: "Project rule one." });
  await updateChannelInstructions(slug, customMeta, { text: "Project rule two." });
  const customContent = readFileSync(path.join(custom, "CLAUDE.md"), "utf8");
  assert.equal(splitGatewayBlock(customContent).found, false);
  assert.equal(customContent, "Project rule one.\n\nProject rule two.\n");

  // A project that keeps AGENTS.md as the real file with the gateway's mirror link on CLAUDE.md
  // is edited through the link's exact sibling shape only.
  const mirrored = mkdtempSync(path.join(allowedFsRoot(), "cg-mirror-"));
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
  const custom = mkdtempSync(path.join(allowedFsRoot(), "cg-project-"));
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

// ── What the ENGINE is told about its own channel ─────────────────────────────
// Live QA (both engines): asked whether it was allowed on the network, a run answered that
// "nothing in my system context, channel instructions, or session config mentions it either way"
// — and it was right. CLAUDE.md is the file both harnesses read (Claude via
// --append-system-prompt-file, Codex via the AGENTS.md symlink), so the channel's own switches
// belong in its gateway-managed block.
test("the managed block states this conversation's mode and network switch, in both directions", async () => {
  const { NETWORK_ADVISORY_NOTE } = await import("../src/engines/network-policy.js");

  const off = channelSwitchesNote({ allowBash: true });
  assert.match(off, /Mode: \*\*bash\*\*/);
  assert.match(off, /Network: \*\*off\*\*/, "an off switch is SAID, not implied by silence");
  assert.match(off, /NOT meant to use the internet/);
  // Honest, not a lie the first successful request would expose: the container is not cut off.
  assert.ok(off.includes(NETWORK_ADVISORY_NOTE), "the advisory caveat is the shared phrase");
  assert.match(off, /that is not permission/i);

  const on = channelSwitchesNote({ autoMode: true, allowNetwork: true, engine: "claude" });
  assert.match(on, /Mode: \*\*auto\*\*/);
  assert.match(on, /Network: \*\*on\*\*/);
  assert.doesNotMatch(on, /NOT meant to use the internet/);

  // An engine that cannot run with the network on is told that, not promised the switch.
  assert.match(channelSwitchesNote({ allowNetwork: true, engine: "opencode" }), /cannot run with the network on/);

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

    // 1. Composio identity + the privacy stop. Both identities are named, and an unnamed request
    //    that either could serve is answered with a question, not a "harmless" read (CO-04).
    assert.match(block, /`composio-user`/);
    assert.match(block, /`composio-agent`/);
    assert.match(block, /which account\?" — not a tool call/);

    // 2. A request phrased for the requester's OWN accounts is `composio-user` or nothing — the
    //    agent's shared identity is never substituted for a missing personal one (CO-02: a
    //    requester with no personal token asked for "my Gmail" and was told a third employee's
    //    mailbox identity and subject lines).
    assert.match(block, /"My X" is the requester's X/);
    assert.match(block, /served ONLY by `composio-user`/);
    assert.match(block, /do not read\n?\s*`composio-agent` to answer it/);
    assert.match(block, /holds OTHER people's/);
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
});
