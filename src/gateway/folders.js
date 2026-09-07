// Channel folder provisioning. For each conversation we create a gated folder and write a
// `.claude/settings.json` straight from the `channelgate` skill template: the tool permissions
// its mode grants, persistent memory off, and a permission allowlist limited to the channel's
// granted MCP namespaces (+ Composio, per author). The file is POLICY — confinement is the channel
// container the folder is mounted into. Skills the channel is granted are copied into the folder. Everything here is idempotent — safe to re-run on
// every message so config changes in the admin UI take effect on the next turn.
import { mkdir, writeFile, cp, access, readdir, realpath, readlink, rename, symlink, lstat, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelFolder, channelSettingsFile, channelAdminSettingsFile, cleanWorkspaceFolder, workspaceFolder, gatewayRoot } from "../config/paths.js";
import { allowedFsRoot, resolveWithinRoot } from "../web/security.js";


// The directory Claude actually runs in for a channel: a custom meta.workDir when set to a
// valid absolute, existing path; otherwise the visible default workspace folder
// (~/ChannelGate/<platform>/<slug>). The lockdown settings file always lives in the hidden
// per-channel metadata folder and is passed to Claude via --settings, so a custom (real-project)
// folder is never clobbered, and config/secrets stay out of the visible workspace.
export function effectiveWorkDir(slug, meta = {}) {
  // Clean mode runs in the bare gateway folder — a custom (real-project) work dir is ignored so its
  // own AGENTS.md/CLAUDE.md (project context, often large) isn't loaded. This is what makes "load
  // clean" reach the model's base prompt; the small gateway-generated instructions still apply.
  // Use a dedicated bare workspace under the gateway runtime instead of a child of the normal
  // project. Codex walks repository ancestors for `.agents/skills`; nesting `.gateway-clean`
  // beneath a git worktree therefore re-imported the very project skills clean mode excludes.
  // A clean turn can overlap a regular turn, so mutating the shared `.claude/skills` tree here
  // would either leak grants into clean mode or revoke them underneath the regular author.
  if (meta.cleanMode) return cleanWorkspaceFolder(slug, meta.platform);
  const w = (meta.workDir || "").trim();
  if (w && path.isAbsolute(w)) {
    // Read-time containment: the write entry points (admin UI, MCP tool) already validate, but a
    // workDir stored BEFORE the allowlist existed (or before an admin tightened the root) would
    // otherwise be honored as run cwd + mounted work folder forever. Re-check here — one chokepoint
    // covers runs, background jobs, lockdown generation, and the memory routes.
    const real = resolveWithinRoot(allowedFsRoot(), w);
    if (real) {
      try {
        if (statSync(real).isDirectory()) return real;
      } catch {
        /* vanished since resolve — fall back */
      }
    } else {
      console.warn(`[workdir] stored workDir ${w} escapes the allowed root — using the default folder for ${slug}`);
    }
  }
  return workspaceFolder(slug, meta.platform);
}
import { allowMatchesFor, gatewayToolRefs, namespacesFor } from "./mcp-catalog.js";
import { applyGatewayGuide } from "./guide.js";
import { DEFAULT_PLATFORM } from "../platforms/registry.js";
import { channelMode, networkState } from "./modes.js";
import { NETWORK_ADVISORY_NOTE, NETWORK_POLICY_ENFORCED } from "../engines/network-policy.js";
import { getAgentsFile, getAgentsInstructions, getComposioMode, getOrgAccessGrants } from "../config/settings.js";
import { memoryEnabled, MEM_FILE, applyChannelMemory } from "./channel-memory.js";
import { isLibraryStub, splitFavorites, ensureCodexSkillsLink, pruneLegacyLibraryStubs } from "./library-skills.js";
import { MANAGED_SKILL_MARKER, materializeSkill, pruneManagedSkills } from "./skills/materialize.js";
import { listSkills as listCatalogSkills } from "./skills/catalog.js";
import { withDependencies } from "./skills/resolve.js";
import { channelSkillGrants } from "./skills/templates.js";
import { archiveWorkspaceEntry } from "./skills/workspace-backup.js";
import { readSkillDirectory } from "./skills/import-folder.js";
import { normalizeSkillFiles, hashSkillFiles } from "./skills/files.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { sanitizeSkillGrantNames } from "./access-grants.js";
import { readNoFollow, writeNoFollow, ensureRealDir } from "./safe-fs.js";
// Capability reads only — never the registry or the resolver (resolve.js imports THIS module for
// effectiveWorkDir, so the dependency has to stay one-way). contract.js imports nothing but
// node:crypto, which is what makes that safe.
import { IMAGE_HELPERS } from "../runtimes/container/image-paths.js";

// Legacy markers — the old standalone memory block in CLAUDE.md; only stripped on migration now.
// The memory system lives OUTSIDE the instruction file: a `channel-memory` skill (protocol) + the
// `update_channel_memory` gateway MCP tool (write path) + the MEMORY.md index / memory/ topic files
// — see channel-memory.js.
const MEM_START = "<!-- GATEWAY-MEMORY:START -->";
const MEM_END = "<!-- GATEWAY-MEMORY:END -->";

// The ONLY symlink shape the gateway ever created at an instruction-file path: a relative link to
// its sibling. Migration and update_channel_instructions accept a link solely when readlink()
// returns exactly this — anything else was planted by the agent and is never traversed.
const LEGACY_MIRROR_TARGET = "AGENTS.md";

// Strip a delimited managed block (between start/end markers) from content, returning the rest.
function stripBlock(content, start, end) {
  const i = content.indexOf(start);
  if (i === -1) return content;
  const j = content.indexOf(end, i);
  const e = j === -1 ? content.length : j + end.length;
  return (content.slice(0, i) + content.slice(e)).replace(/\n{3,}/g, "\n\n");
}

// ── Gateway-managed instructions block ────────────────────────────────────────
// The per-channel CLAUDE.md is the channel's OWN instructions (user/agent-owned, persistent,
// never overwritten). The gateway contributes exactly one delimited block at the TOP of the
// file — this conversation's switches, the hard rules, and the admin's global instructions
// (Settings → Behavior) — refreshed in place only when its content changes. (How to operate inside
// the chat surface — formatting, mentions, the gateway tools — lives in the always-injected
// `gateway-usage` skill, not here; see guide.js. Only the handful of rules a run must never get
// wrong is duplicated here, because a skill body is read only if the model opens it.) Both engines
// read the same file (AGENTS.md is a symlink), so this one mechanism covers Claude and Codex,
// survives /clear (a new session re-reads the file), and never touches anything below the marker.
const GW_START = "<!-- GATEWAY-INSTRUCTIONS:START -->";
const GW_END = "<!-- GATEWAY-INSTRUCTIONS:END -->";
const GW_NOTE = `> ⚙️ Gateway-managed block — do NOT edit between these markers; the gateway refreshes this
> section automatically (this conversation's switches, the gateway's hard rules, and the admin's
> global instructions). Everything BELOW the end marker is this channel's own standing instructions:
> it persists across sessions and is never overwritten. To add a durable channel rule when asked,
> use the gateway tool \`update_channel_instructions\` (or edit the file where file writes are
> allowed).`;

// What each mode actually grants, in the agent's own terms — the label alone ("Bash") does not
// tell a model what it may do.
const MODE_NOTE = {
  read: "read-only tools; anything else asks this conversation for approval first",
  worker: "shell commands and file writes inside this conversation's container",
  auto: "autonomous — permission prompts are auto-approved, so nothing stops to ask",
  admin: "every tool with permission prompts bypassed, for an admin author's live turns",
};

// The conversation's OWN switches, stated to the engine. Nothing used to: a run could read the
// operating manual, its channel instructions and its session config and still find no statement of
// whether this channel was meant to use the network — so it guessed, and guessed differently each
// turn. Both switches are named in both directions.
//
// The network line is deliberately honest about being ADVISORY (see engines/network-policy.js):
// the container is on the bridge network and no egress is policed per channel, so "off" is an
// instruction to obey, not a wall that will stop a request. A model told "you have no network"
// would call the switch broken the first time curl succeeded; a model told the truth respects it.
export function channelSwitchesNote(meta = {}) {
  const mode = channelMode(meta);
  const network = networkState(meta);
  const networkLine =
    network === "on"
      ? "**on** — this conversation is meant to use the internet. There is no per-domain allow-list."
      : network === "unsupported"
        ? "requested **on**, but this conversation's engine cannot run with the network on — treat it as off."
        : `**off** — this conversation is NOT meant to use the internet: don't fetch, install, push or call out, and say the switch is off instead of trying. ${NETWORK_POLICY_ENFORCED ? "" : `The switch is ${NETWORK_ADVISORY_NOTE}, so a request may still succeed — that is not permission.`}`.trim();
  return [
    "**This conversation's switches** (an admin sets them; they apply from the next message):",
    `- Mode: **${mode}** — ${MODE_NOTE[mode]}.`,
    `- Auto: **${meta.autoMode ? "on" : "off"}** — ${meta.autoMode ? "tool requests are automatically approved for every authorized member" : "tools outside the mode allowlist require approval"}.`,
    `- Lean: **${meta.cleanMode ? "on" : "off"}** — ${meta.cleanMode ? "bare model without skills or connectors" : "configured skills and connectors are available"}.`,
    `- Network: ${networkLine}`,
  ].join("\n");
}

// The few rules a run must never get wrong, stated where EVERY run actually reads them.
//
// They are also in the `gateway-usage` skill, at length and with the reasoning — but a skill body
// is only read when the model decides to open it, and the retest wave (2026-09-06) showed one
// harness never did: across the failing transcripts the string `gateway-usage` appeared only in the
// skills catalog listing, and none of the new rule text appeared at all, while the other engine —
// reading the identical text through the AGENTS.md symlink — followed it. The cost of that miss is
// not a style slip: a personal calendar read into a public channel, a stray authorization request
// created by an "inventory" call, a follow-up promised on a background process that dies with the
// turn. So the irreducible core lives HERE, in the managed block that is appended to the system
// prompt of every run in every mode. Keep it SHORT (it is prompt weight on every turn, and a long
// block is skimmed like the skill was): the rule and the consequence, never the how-to — the tool
// shapes, parameters and examples stay in the skill's references.
//
// Written engine-neutrally ("your harness's own backgrounding"), because the same file reaches
// every engine, and gated on nothing: a channel without Composio simply has no tool the first three
// rules can apply to, which the closing line says out loud.
//
// The "my X" rule (CO-02, 2026-09-06) is the same failure one rung further down. A non-admin
// requester with NO personal Composio token asked for THEIR OWN mailbox; the run had only
// `composio-agent`, silently used it, and reported a third employee's address and subject lines as
// the requester's. Substitution is worse than ambiguity: the request was not ambiguous at all, and
// the shared identity is exactly where OTHER people's accounts live. One engine refused; the other
// substituted, because the rule against it lived only in the skill body.
//
// It is stated as a rule and not enforced structurally on purpose, and it is written to be
// checkable by the model against its OWN tool list — this file is the channel's shared CLAUDE.md
// (Claude reads it via --append-system-prompt-file, Codex through the AGENTS.md symlink), so it can
// never name WHICH identities a given run received: `composio-user` is per-AUTHOR, and two people
// messaging the same channel concurrently would race a per-author sentence through one shared file.
//
// That per-run fact rides the PROMPT instead (CO-04, 2026-09-07: with both identities injected, one
// engine answered "check the calendar" from the shared identity and posted a colleague's week into
// the channel, where the other asked "which account?" first). `run.js` prepends one line naming the
// identities this turn actually received, next to the fresh-session memory catalog and the
// caller's provenance note — per run, per author, so there is no shared file to race. Its text and
// the predicate behind it live in src/gateway/mcp.js, beside the code that names those servers.
const HARD_RULES = `**Hard rules (not optional)** — they apply wherever the named tools exist; the reasoning and the
tool shapes are in the \`gateway-usage\` skill:
- **Two Composio identities.** \`composio-user\` = the REQUESTER's own accounts; \`composio-agent\` = the
  shared agent's own (either may appear with \`_\` for \`-\`). If the request names neither and BOTH
  could serve it, your reply is the question "which account?" — not a tool call, not a read-only
  peek: a guessed read puts someone's private data in front of everyone here, and no correction
  takes it back.
- **"My X" is the requester's X — never the shared one.** A request phrased for the person asking
  ("my inbox", "my calendar", their own name) is served ONLY by \`composio-user\`. If \`composio-user\`
  is absent from this run, or has no connection for that app, SAY THAT and stop — do not read
  \`composio-agent\` to answer it, not even to check: the shared identity holds OTHER people's
  accounts, so reporting its address, events or subjects as "yours" hands a third party's mail to
  whoever is in this conversation. The mirror is a rule too: "your X" / "the agent's X" never
  touches \`composio-user\`.
- **An inventory is not a connection.** Ask what is connected with that identity's
  \`COMPOSIO_SEARCH_TOOLS\` (read \`toolkit_connection_statuses[]\`). \`COMPOSIO_MANAGE_CONNECTIONS\` —
  any action, \`list\` included — INITIATES connections and raises authorization requests; use it only
  for a toolkit already known connected, or when the user explicitly asked to connect one.
- **Only the gateway can report back after this turn.** Your harness's own backgrounding (a
  background \`Bash\`/shell, background Agent-or-subagent options, \`nohup\`/\`setsid\`, in-turn sleep
  loops) dies with this turn and can never post a follow-up — never promise "I'll report back" on
  one. The durable mechanisms are only the gateway tools \`run_in_background\` (shell; auto/admin
  channels), \`run_agent_in_background\` and \`create_schedule\`; if this conversation's mode allows
  none of them, say so plainly instead of promising. A bounded "check every N minutes, K times" is
  one of these too: \`create_schedule\` (or \`run_agent_in_background\` for a self-contained watcher),
  never an in-turn sleep/poll loop, a \`Monitor\`-style wait, or a harness background task — even when
  the loop would finish inside this turn.`;

// Compose the managed block for a channel: the do-not-edit note, this conversation's switches, the
// hard rules, and (outside clean mode) the admin's global instructions. Deliberately nothing about
// memory or chat formatting here — the memory system ships as the `channel-memory` skill (+
// update_channel_memory tool) and the operating manual as the `gateway-usage` skill, so CLAUDE.md
// stays free of that plumbing. Two exceptions earn their place: the switches, which are
// per-conversation FACTS the shared guide has nowhere to put, and the hard rules, which have to
// hold even for a run that never opens the guide. The hard rules ride clean mode too — a lean
// channel can still hold Composio identities and can still promise a follow-up it cannot keep.
export function gatewayInstructionsBlock(meta = {}) {
  const g = meta.cleanMode ? "" : getAgentsInstructions().trim();
  const parts = [GW_NOTE, channelSwitchesNote(meta), HARD_RULES];
  if (g) parts.push(g);
  return `${GW_START}\n${parts.join("\n\n")}\n${GW_END}`;
}

// Split a file into { rest } with the gateway block removed. Self-repairing: with both markers
// present the whole span is dropped; with exactly one marker (user deleted the other) only the
// orphaned marker LINE is dropped — stale block text then shows up as channel content (visible
// and recoverable) instead of us guessing at a boundary and eating user content.
export function splitGatewayBlock(content) {
  const i = content.indexOf(GW_START);
  const j = content.indexOf(GW_END);
  if (i !== -1 && j !== -1 && j > i) {
    const rest = content.slice(0, i) + content.slice(j + GW_END.length);
    return { found: true, rest: rest.replace(/\n{3,}/g, "\n\n") };
  }
  if (i === -1 && j === -1) return { found: false, rest: content };
  const rest = content
    .split("\n")
    .filter((l) => l.trim() !== GW_START && l.trim() !== GW_END)
    .join("\n");
  return { found: false, rest };
}

// Seed content for a channel whose own section is empty — explains the contract to whoever
// opens the file (and to the agent).
export function channelSeed(name) {
  return `# ${name || "Channel"} — channel instructions

(Standing rules and context for this channel go below. They persist across all sessions and are
never overwritten by the gateway — edit them in the admin UI, by hand, or ask the agent to add a
rule.)`;
}

// Detect any existing entry (file or symlink) at a path.
async function pathKind(p) {
  try {
    return (await lstat(p)).isSymbolicLink() ? "link" : "file";
  } catch {
    return null;
  }
}

// LEGACY: the Slack formatting guidance used to be appended to every instruction file. It now
// lives in the always-injected `gateway-usage` skill (guide.js). This constant is retained ONLY so
// the migration below (legacyChannelContent) can strip the old inline copy out of pre-existing
// CLAUDE.md files — it is no longer injected anywhere.
const SLACK_FORMAT_GUIDE = `## Slack replies — keep them SHORT
You're replying inside Slack, not a terminal or a doc:
- Lead with the outcome + the few key results, in a handful of lines. LONG messages get hidden
  behind a "Show more" fold that's annoying to expand — so don't paste long logs, full file
  dumps, or step-by-step narration. Offer details only if asked.
- The gateway already shows your progress (a status indicator), so don't post "now I'll do X"
  play-by-play updates — just send the final answer, concisely.
- Slack does NOT support Markdown tables, \`#\` headings, or HTML. Use \`*bold*\` (single asterisks,
  not \`**\`), \`_italics_\`, \`\\\`code\\\`\`, fenced code blocks, and "• " bullets. No \`#\` headings —
  use a short \`*bold label*\` instead. If a table is unavoidable, keep it small in a code block.
- Prefer a compact native Slack shape: one bold outcome line, then 2-4 short bullets only when they
  add scan value. Bold the label, not the whole sentence (for example: \`*Fixed:* restart now stops
  old Codex processes\`).
- To @-mention someone, write their plain name after an "@" (e.g. @Alex or @Alex Doe) —
  the gateway rewrites it into a real Slack ping. NEVER write a raw \`<@U…>\` id: it gets escaped and
  renders as literal text, pinging no one. Only workspace members resolve; if a name doesn't ping,
  it isn't in the directory.`;

function instructionsBody(meta) {
  // Create-once content for CUSTOM (real-project) folders only — no managed markers, never
  // refreshed (we don't manage blocks inside a file that may be committed to the project's repo).
  // Slack operating guidance is NOT baked in here anymore — it rides in the `gateway-usage` skill.
  const perChannel = typeof meta.instructions === "string" ? meta.instructions.trim() : "";
  const g = perChannel || getAgentsInstructions().trim();
  const base = g || `# ${meta.name || meta._slug || "Channel"}\n\nYou are a helpful assistant operating in this Slack channel.`;
  return `${base.replace(/\s+$/, "")}\n`;
}

// Reduce a legacy generated CLAUDE.md to just the channel-owned remainder. Old files were fully
// regenerated every turn as (meta.instructions || global || stub) + Slack guide + memory block, so
// we strip each known generated segment; whatever survives is genuine channel content.
function legacyChannelContent(content, meta) {
  let rest = splitGatewayBlock(content).rest;
  rest = stripBlock(rest, MEM_START, MEM_END);
  rest = splitFavorites(rest).base;
  rest = rest.split(SLACK_FORMAT_GUIDE).join("");
  const t = rest.trim();
  if (!t) return "";
  if (t === getAgentsInstructions().trim()) return ""; // was the baked-in global default
  if (/^# .+\n+You are a helpful assistant operating in this Slack channel\.$/.test(t)) return ""; // old stub
  return t;
}

// Ensure CLAUDE.md (read by Claude) exists with AGENTS.md symlinked to it (read by Codex), so the
// same instructions reach both engines. For gateway-owned default folders the file is:
//   [gateway-managed block: global instructions + Slack guide + memory note]  ← refreshed on change
//   [the channel's OWN instructions]                                          ← NEVER touched
// The channel section is seeded once (from legacy meta.instructions or a stub) and then belongs to
// the user/agent — the gateway only ever upserts the delimited block above it. A custom
// (real-project) work dir is never block-managed: we keep whichever instruction file the project
// has and only fill in the missing counterpart. Controlled by the "agentsFile" setting.
async function ensureInstructionFiles(cwd, slug, meta) {
  if (!getAgentsFile()) return;
  const agents = path.join(cwd, "AGENTS.md");
  const claude = path.join(cwd, "CLAUDE.md");
  const isDefault = cwd === workspaceFolder(slug, meta?.platform); // gateway-owned default workspace

  // Migrate the old layout (AGENTS.md real + CLAUDE.md → AGENTS.md) to the new one (CLAUDE.md the
  // real file, AGENTS.md → CLAUDE.md). Only for gateway-owned default folders; a custom project
  // keeps whatever real file it already has. Detect by CLAUDE.md being a symlink — but accept ONLY
  // the exact legacy shape (a relative "AGENTS.md" link with a REAL file behind it). Any other
  // link was not created by the gateway: the workspace is agent-writable, and a link pointed at
  // daemon-readable secrets would have this migration copy them into the workspace. Unknown links
  // are removed without ever reading through them.
  if (isDefault && (await pathKind(claude)) === "link") {
    let target = "";
    try {
      target = await readlink(claude);
    } catch {
      /* vanished — nothing to carry over */
    }
    // readNoFollow refuses a link and returns null for a directory, so content only ever comes
    // from a real sibling AGENTS.md reached without traversing the link.
    const content = target === LEGACY_MIRROR_TARGET ? ((await readNoFollow(agents)) ?? "") : "";
    // recursive: the pair is rebuilt below, and a directory squatting on either name (which plain
    // rm would throw on, wedging every later turn) is agent-planted junk in a gateway-owned folder.
    await rm(claude, { force: true, recursive: true });
    await rm(agents, { force: true, recursive: true });
    if (content.trim()) await writeNoFollow(claude, content);
  }

  if (isDefault) {
    // No-follow read/write: after the migration above CLAUDE.md is a regular file or absent, but
    // an agent may re-plant a link at any moment — never read through or write through one.
    const cur = (await readNoFollow(claude)) ?? "";
    // Channel-owned section: everything outside the managed block, with legacy generated
    // boilerplate stripped once on migration. Seed when empty; preserved verbatim ever after.
    let own = legacyChannelContent(cur, meta);
    if (!own) own = (typeof meta.instructions === "string" && meta.instructions.trim()) || channelSeed(meta.name || slug);
    const want = `${gatewayInstructionsBlock(meta)}\n\n${own.replace(/\s+$/, "")}\n`;
    if (cur !== want) await writeNoFollow(claude, want);
    await ensureMirrorSymlink(agents, "CLAUDE.md", claude);
  } else {
    // Custom project folder: respect whichever instruction file the project already has as the
    // real one and symlink the other to it. If neither exists, create CLAUDE.md (real) — matching
    // the default's CLAUDE.md-first orientation — and symlink AGENTS.md to it.
    const agentsKind = await pathKind(agents);
    const claudeKind = await pathKind(claude);
    if (claudeKind === null && agentsKind === null) {
      await writeNoFollow(claude, instructionsBody(meta));
      await ensureMirrorSymlink(agents, "CLAUDE.md", claude);
    } else if (claudeKind === null && agentsKind === "file") {
      await ensureMirrorSymlink(claude, "AGENTS.md", agents); // keep the project's AGENTS.md as source
    } else if (agentsKind === null && claudeKind === "file") {
      await ensureMirrorSymlink(agents, "CLAUDE.md", claude);
    }
    // both already present → leave as-is
  }
}

// Create `linkPath` as a symlink to a sibling `target` filename, but only when `linkPath` is
// absent and the target actually exists. Never clobbers an existing file/link.
async function ensureMirrorSymlink(linkPath, target, targetPath) {
  if ((await pathKind(linkPath)) !== null) return;
  if ((await pathKind(targetPath)) === null) return;
  try {
    await symlink(target, linkPath);
  } catch {
    /* race / unsupported — ignore */
  }
}

// Append to (or replace) the channel-owned section of the channel's CLAUDE.md. Used by the
// `update_channel_instructions` gateway MCP tool so "add a rule that X" works in every mode —
// the daemon-side MCP process writes the file on the daemon host, outside the run's container. The existing managed block is
// kept verbatim (default folders); a block-less file (custom project folder) is appended to
// as-is. Returns { path }.
export async function updateChannelInstructions(slug, meta, { text, replace = false }) {
  const cwd = effectiveWorkDir(slug, meta);
  let file = path.join(cwd, "CLAUDE.md");
  // A custom project folder may keep AGENTS.md as the real file with CLAUDE.md as the gateway's
  // mirror link (see ensureInstructionFiles). Follow ONLY that exact sibling shape; any other
  // symlink is agent-planted and treated as absent — never read or written through.
  if ((await pathKind(file)) === "link") {
    let target = "";
    try {
      target = await readlink(file);
    } catch {
      /* vanished */
    }
    const agents = path.join(cwd, LEGACY_MIRROR_TARGET);
    if (target === LEGACY_MIRROR_TARGET && (await pathKind(agents)) === "file") file = agents;
  }
  const cur = (await readNoFollow(file)) ?? "";
  const isDefault = cwd === workspaceFolder(slug, meta?.platform);
  const addition = text.replace(/\s+$/, "");
  let next;
  if (isDefault) {
    const hasBlock = splitGatewayBlock(cur).found;
    const block = hasBlock ? cur.slice(cur.indexOf(GW_START), cur.indexOf(GW_END) + GW_END.length) : gatewayInstructionsBlock({ ...meta, _slug: slug });
    const own = splitGatewayBlock(cur).rest.trim();
    const combined = replace || !own ? addition : `${own}\n\n${addition}`;
    next = `${block}\n\n${combined}\n`;
  } else {
    // Custom project folder: never inject a managed block — just edit the file's own content.
    next = replace || !cur.trim() ? `${addition}\n` : `${cur.replace(/\s+$/, "")}\n\n${addition}\n`;
  }
  await mkdir(cwd, { recursive: true });
  await writeNoFollow(file, next);
  return { path: file };
}

// Read-only built-in tools we auto-approve for everyone. Writes/Bash are deliberately NOT
// here: a non-admin author runs headless (no way to answer a prompt), so anything not on this
// list is effectively denied for them. Admin authors bypass this via --dangerously-skip
// (only honored by the admin-run settings variant of an adminMode channel — see
// disableBypassPermissionsMode below).
const SAFE_BUILTIN_TOOLS = ["Read", "Glob", "Grep"];

// Unlocked per-channel by `allowBash` ("Allow shell"). Bash can write via redirection anyway, so
// the file-write tools are unlocked alongside it. Confinement is the channel container: the shell
// sees the container's own HOME volume and the mounted work folder, never the daemon's filesystem
// or another channel's. This is a capability grant, NOT the full escalation of admin mode.
const SHELL_TOOLS = ["Bash", "Write", "Edit", "MultiEdit"];

// The shell tools a channel WITHOUT `allowBash`/`autoMode` must route through an approval card.
// Leaving Bash out of `allow` is not enough on its own: Claude Code answers a simple command whose
// argv head sits on its own built-in read-only list (`id`, `cat`, `head`, `tail`, `wc`, `strings`,
// `uname`, …) before it ever consults --permission-prompt-tool, so a read-mode turn executed
// `id -un` with no card and no approval row (QA, 2026-09-05) — arbitrary read-only shell inside the
// channel's container, sidestepping the Read tool's folder scoping. An `ask` rule is evaluated
// ahead of that layer, so naming Bash here sends EVERY command — simple or compound — to the
// permission prompt tool, i.e. the Slack approval card, which is what Read mode promises.
const ASK_WITHOUT_SHELL = ["Bash"];

// Trusted host sources for pre-catalog grants. First match wins; workspace copies track its bytes.
export function skillSourceDirs() {
  if (process.env.GATEWAY_SKILL_SOURCES) {
    return process.env.GATEWAY_SKILL_SOURCES.split(":").filter(Boolean);
  }
  return [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Mechanical subagent-completion enforcement: a Stop hook the Claude CLI runs on every attempted
// turn end. It blocks the stop while background Agent/Task subagents or Workflows are still
// running, so their results can't be silently orphaned by the turn ending (process exit / idle-kill
// would take them down). The script is baked into the channel image at a fixed path
// (src/runtimes/container/image-paths.js); the checkout copy below is its source, and the daemon's
// own probes do not run it.
export const STOP_SUBAGENTS_HOOK = fileURLToPath(new URL("./hooks/stop-subagents.mjs", import.meta.url));

function stopHookCommand() {
  const { command, args = [] } = IMAGE_HELPERS["stop-subagents-hook"];
  return [command, ...args].map((part) => (/[\s"'\\$]/.test(String(part)) ? JSON.stringify(String(part)) : String(part))).join(" ");
}

export function subagentStopHooks() {
  return { Stop: [{ hooks: [{ type: "command", command: stopHookCommand() }] }] };
}

// The directories a Full-access channel's container mounts beyond its own folders — today only
// the operator home (lifecycle.js operatorHomeMounts). Read off the resolved target so the
// settings file can never name a host path the container does not actually have.
export function operatorHomeDirectories(target) {
  return (target?.container?.mounts || [])
    .filter((m) => m.kind === "operator-home" && m.target)
    .map((m) => m.target);
}

// Build the settings object for a channel from its meta. `allowBypass` is set ONLY for the
// admin-run settings variant (see ensureChannelFolder): the shared channel settings file always
// hard-disables the --dangerously-skip-permissions bypass. It is one switch with three linked
// effects — omit the bypass key, grant the shell (see `bashy`), and add the operator home when the
// container mounts it — because the run that receives this file is exactly the run that spawns
// with the bypass flag; a permission this file withholds from it is a contradiction the CLI
// resolves as a denial, not as the escalation the mode advertises.
//
// What this file carries is POLICY, not confinement: the tool permissions a mode grants, the MCP
// allowlist, memory-off and the Stop hook. Confinement is the channel container — its per-channel
// HOME volume, the mounted work folder, and its network mode — so there is no sandbox block here
// and no host path of any kind (the engine never sees the daemon's filesystem). The one path that
// can appear is the operator home in `permissions.additionalDirectories` of the ADMIN variant, and
// only when the channel's container actually mounts it (`target.container.mounts`, kind
// "operator-home"): Claude Code confines its file tools to the cwd plus these directories, so
// without the entry a Full-access channel could see the home in Bash but not Read/Edit it.
export async function buildSettings(meta, { allowBypass = false, target = null } = {}) {
  // Clean mode: run bare — no MCP servers reachable at all (the per-run --mcp-config is empty +
  // strict, and the allowlist is empty too), and no MCP tool namespaces pre-approved.
  const clean = Boolean(meta.cleanMode);
  const namespaces = clean ? [] : await namespacesFor(meta.allowedMcps);
  const gatewayTools = clean ? [] : gatewayToolRefs();
  // The injected remote servers need their URLs in the allowlist as well as their names — a picked
  // global server (a serverUrl entry) otherwise makes Claude Code drop them (mcp-catalog.js).
  const allowMatches = clean ? [] : await allowMatchesFor(meta.allowedMcps, {
    makeToolboxUrl: meta.makeToolboxUrl,
    composioSdk: getComposioMode() === "sdk",
  });

  // Auto mode (autonomous: permission prompts auto-approved — see requestApproval) gets the same
  // file-writing tools as Allow Bash, so the agent can actually do file work without prompts.
  //
  // So does the admin-run variant (allowBypass), whatever the channel's own flags say. It is
  // handed ONLY to an admin author in an adminMode channel — the same turn that spawns with
  // --dangerously-skip-permissions — so the shell is already permitted there and granting it here
  // widens nothing. Saying otherwise in the file actively TOOK the shell away: the "full" profile
  // sets adminMode alone (never allowBash/autoMode), the variant inherited read mode's
  // `ask: ["Bash"]`, and Claude Code kept evaluating that rule for the bypassed run — a bare `pwd`
  // came back denied and the admin turn fell back to read-only (QA, 2026-09-07).
  const bashy = Boolean(meta.allowBash || meta.autoMode || meta.adminMode || allowBypass);

  // Folder-scoped memory: when on (and the channel isn't already bash-enabled, which grants Write/
  // Edit broadly), grant a NARROW Write/Edit limited to MEMORY.md so the agent can persist memory
  // without unlocking general file writes.
  const memTools = memoryEnabled(meta) && !bashy ? [`Write(${MEM_FILE})`, `Edit(${MEM_FILE})`] : [];

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",

    // MCP allowlist: only these servers are reachable when running interactively in the
    // folder. (The headless runner additionally passes --strict-mcp-config.)
    allowedMcpServers: allowMatches,

    // Persistent memory fully disabled for gateway folders.
    autoMemoryEnabled: false,
    autoDreamEnabled: false,

    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [],

    permissions: {
      defaultMode: "default",
      // The --dangerously-skip-permissions bypass is hard-disabled in the SHARED settings file so
      // the flag can never escalate a non-admin context (even in an adminMode channel). Only the
      // separate admin-run variant (allowBypass, written alongside for adminMode channels and
      // passed per-spawn to admin authors only — see ensureChannelFolder + run.js) allows it, by
      // OMITTING this key: "disable"/absent are the only values Claude Code accepts here — any
      // other value (including "allow") makes the CLI silently discard the ENTIRE settings file,
      // which would strip the Stop hook, deny list and memory-off from the run.
      ...(allowBypass ? {} : { disableBypassPermissionsMode: "disable" }),
      disableAutoMode: "disable",
      additionalDirectories: allowBypass ? operatorHomeDirectories(target) : [],
      allow: [...SAFE_BUILTIN_TOOLS, ...(bashy ? SHELL_TOOLS : []), ...memTools, ...namespaces, ...gatewayTools],
      // Everything the mode did not grant asks (see ASK_WITHOUT_SHELL). Only when the shell is NOT
      // granted: `ask` outranks `allow`, so listing Bash here for a bash/auto channel — or for the
      // admin-run variant, which is bashy by definition — would put an approval card in front of
      // every command it is meant to run unattended, and headless there is nobody to answer it.
      ...(bashy ? {} : { ask: [...ASK_WITHOUT_SHELL] }),
      // Never Write/Edit: `deny` outranks `allow`, and it would void the narrow
      // Write(MEMORY.md)/Edit(MEMORY.md) grant above that folder-scoped memory depends on.
      deny: ["mcp__claude-in-chrome", "mcp__computer-use"],
    },

    // Refuse to end a turn while background subagents are still running (all modes, clean
    // included — the orphaned-subagent hazard is mode-independent). See hooks/stop-subagents.mjs.
    hooks: subagentStopHooks(),
  };
}

function metaSlug(meta) {
  // meta carries its slug under _slug (set by ensureChannelFolder) or is keyed externally.
  return meta._slug;
}

// Write only when content differs from what's on disk — ensureChannelFolder runs per message,
// and identical rewrites are the common case. No-follow on both sides: a symlink at the path
// reads as "missing" and is replaced as a node (exclusive temp + rename), never written through.
async function writeIfChanged(file, content) {
  if ((await readNoFollow(file)) === content) return;
  await writeNoFollow(file, content);
}

// Create/refresh the gateway channel folder + lockdown settings, enable granted skills, and
// return { cwd, settingsFile, adminSettingsFile }: the dir Claude runs in (custom or default)
// and the lockdown file(s) to pass via --settings. The settings files always live in the gateway
// folder, so a custom (real-project) work dir is never overwritten; skills are copied into the
// work dir.
// Backups live in daemon metadata, outside all engine discovery paths and normal mounts.
export function workspaceSkillBackupDir(cwd) {
  return path.join(gatewayRoot(), "skill-backups", createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 24));
}

async function entryInfo(file) {
  try { return await lstat(file); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareWorkspaceSkills(cwd, backupDir) {
  await mkdir(cwd, { recursive: true });
  for (const parts of [[".claude"], [".claude", "skills"]]) {
    const entry = path.join(cwd, ...parts);
    const info = await entryInfo(entry);
    if (info && !info.isDirectory()) await archiveWorkspaceEntry(entry, backupDir);
    await ensureRealDir(cwd, ...parts);
  }
  const skillsDir = path.join(cwd, ".claude", "skills");
  // These two protocols are injected independently of catalog grants. Preserve custom copies
  // before allowing their managed writers to take ownership, just like a selected catalog skill.
  for (const [name, marker] of [["gateway-usage", ".gateway-usage-skill"], ["channel-memory", ".gateway-memory-skill"]]) {
    const entry = path.join(skillsDir, name);
    const info = await entryInfo(entry);
    if (info && (!info.isDirectory() || (await readNoFollow(path.join(entry, marker))) === null)) {
      await archiveWorkspaceEntry(entry, backupDir);
    }
  }
  return skillsDir;
}

export async function ensureChannelFolder(slug, meta, { runMeta = meta, target = null } = {}) {
  const { assertWorkspaceSkillsCompatible } = await import("./skills/workspace-sync.js");
  await assertWorkspaceSkillsCompatible(slug, meta);
  // Every per-channel path is namespaced by the channel's platform; an unknown/missing one
  // resolves to Slack in the registry, which is what keeps pre-multi-platform rows working.
  const platform = meta?.platform;
  // Gateway channel folder always exists (holds meta.json, sessions.json, the lockdown file).
  await mkdir(channelFolder(slug, platform), { recursive: true });
  await mkdir(path.dirname(channelSettingsFile(slug, platform)), { recursive: true });

  // The two host directories an isolated runtime bind-mounts at identical absolute paths: the
  // bare clean workspace (so `/clean` works in-container) and this channel's per-run artifact dir
  // (the --settings copy, the --mcp-config file, plugin dirs — see run-grant-artifacts.js). A
  // bind mount of a missing source is either an error or a root-owned directory conjured by the
  // container daemon, so they are created HERE, 0700, before any backend is asked to start.
  // Host targets carry neither, so this is a no-op for them.
  if (target?.cleanWorkDir) await mkdir(target.cleanWorkDir, { recursive: true, mode: 0o700 });
  if (target?.artifactDir) await mkdir(target.artifactDir, { recursive: true, mode: 0o700 });

  // Build ONCE per message; skip the write when on-disk content is already identical.
  const settings = await buildSettings({ ...meta, _slug: slug });
  await writeIfChanged(channelSettingsFile(slug, platform), JSON.stringify(settings, null, 2) + "\n");

  // Admin-run settings variant: the same generator with allowBypass on, which is what decides the
  // whole delta (the omitted bypass key AND the shell grant that goes with it) in ONE place —
  // buildSettings. It used to be a structuredClone with the bypass key deleted, and that quietly
  // left read mode's `ask: ["Bash"]` in a file whose entire point is that the shell is permitted.
  // It exists ONLY while the channel is in admin mode (removed the moment adminMode goes off, so
  // no stale allowance lingers) and is passed via --settings solely for admin-author runs —
  // run.js requires an admin author AND adminMode before selecting it, so a non-admin run never
  // sees a file that would honor --dangerously-skip-permissions.
  const adminSettingsFile = channelAdminSettingsFile(slug, platform);
  if (meta.adminMode) {
    const adminSettings = await buildSettings({ ...meta, _slug: slug }, { allowBypass: true });
    await writeIfChanged(adminSettingsFile, JSON.stringify(adminSettings, null, 2) + "\n");
  } else {
    await rm(adminSettingsFile, { force: true });
  }

  const configureWorkspace = async (cwd, workspaceMeta, skills) => {
    const release = await acquireKeyedLock("workspace-skills", cwd);
    try {
      // Recreate the managed skill tree as REAL directories — a symlink swapped in at .claude/ or
      // skills/ would otherwise route every managed write below to wherever the agent pointed it.
      const backupDir = workspaceSkillBackupDir(cwd);
      const skillsDir = await prepareWorkspaceSkills(cwd, backupDir);
      await ensureCodexSkillsLink(cwd, { authoritative: true, backupDir });
      // Stub folders the retired Skills Manager integration generated are removed on sight: the
      // catalog delivers real files now, and a leftover stub would shadow a same-named skill.
      await pruneLegacyLibraryStubs(skillsDir);
      await renameLegacyManagedSkills(skillsDir);
      const skillSync = await enableSkills(skillsDir, skills, { authoritative: true, backupDir });
      // The gateway-usage skill (the chat operating manual) is injected in EVERY mode — including
      // clean mode — since the bot always replies into a conversation. Resolved for the channel's
      // PLATFORM, so a Teams channel is never told to post a Slack List. Marker-guarded +
      // write-on-change, so a channel that changes surface re-materializes on its next message.
      await applyGatewayGuide(cwd, { platform: workspaceMeta?.platform || DEFAULT_PLATFORM, target });
      await ensureInstructionFiles(cwd, slug, workspaceMeta);
      await applyChannelMemory(cwd, { ...workspaceMeta, _slug: slug });
      if (skillSync.missing.length) console.warn(`[skills] ${slug}: unavailable selected skills: ${skillSync.missing.join(", ")}`);
      return skillSync;
    } finally { release(); }
  };

  // The durable workspace always reflects organization+channel grants. A run-specific clean/mode
  // override may select a different cwd, but must not prune or rewrite this shared baseline.
  // The channel tier: the assigned skill template's current skills plus the conversation's own.
  const channelSkills = sanitizeSkillGrantNames([...(getOrgAccessGrants().skills || []), ...channelSkillGrants(meta)]);
  const durableMeta = { ...meta, cleanMode: false };
  const durableCwd = effectiveWorkDir(slug, durableMeta);
  const skillSync = await configureWorkspace(durableCwd, durableMeta, channelSkills);

  const cwd = effectiveWorkDir(slug, runMeta);
  if (cwd !== durableCwd) {
    await configureWorkspace(cwd, runMeta, runMeta.cleanMode ? [] : channelSkills);
  }

  return {
    cwd,
    skillSync,
    settingsFile: channelSettingsFile(slug, platform),
    // Present only for adminMode channels; run.js swaps it in for admin-author runs.
    adminSettingsFile: meta.adminMode ? adminSettingsFile : "",
  };
}

// List all skill names available to grant for the admin UI: every live catalog skill (the
// canonical set — bundled, authored, synced and imported host folders) plus, for a deployment
// that has not imported its host folders yet, the names found there directly.
export async function listAvailableSkills() {
  const names = new Set();
  try {
    for (const skill of listCatalogSkills()) names.add(skill.slug);
  } catch {
    /* catalog unavailable (no database yet) — fall back to the host folders alone */
  }
  for (const dir of skillSourceDirs()) {
    try {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        // Include real dirs and symlinks (the user's skills are often symlinks).
        if (d.isDirectory() || d.isSymbolicLink()) names.add(d.name);
      }
    } catch {
      /* source dir absent — skip */
    }
  }
  return [...names].sort();
}

// Bundled skills renamed with the product. A channel materialised before the rename still holds
// the old folder in its workspace, and a stored grant still names it. Both are mapped here so the
// rename is invisible to an existing channel.
export const RENAMED_MANAGED_SKILLS = Object.freeze({ "claude-gateway": "channelgate" });

// Marker-guarded rename of a renamed bundled skill's materialised folder. ONLY a copy this daemon
// created (it carries MANAGED_SKILL_MARKER) is ever touched — a hand-made folder that happens to
// share the old name belongs to the channel and is left exactly where it is. When the new name is
// already materialised the stale copy is simply dropped: it is a gateway-owned duplicate.
async function renameLegacyManagedSkills(skillsDir) {
  for (const [from, to] of Object.entries(RENAMED_MANAGED_SKILLS)) {
    const src = path.join(skillsDir, from);
    if (!(await exists(path.join(src, MANAGED_SKILL_MARKER)))) continue;
    const dst = path.join(skillsDir, to);
    try {
      if (await exists(dst)) await rm(src, { recursive: true, force: true });
      else await rename(src, dst);
    } catch {
      /* best effort — a failed rename just leaves the old copy for the next message to retry */
    }
  }
}

// Materialize each granted skill into the given .claude/skills dir. The catalog is the source
// (real files of the skill's effective revision, write-on-change — see skills/materialize.js); a
// grant that names nothing in the catalog falls back to the pre-catalog host-folder copy so an
// un-imported folder keeps working. Managed copies whose grant ended are pruned; a project-owned
// folder of the same name is preserved only for callers that opt out of authoritative mirroring.
export async function enableSkills(skillsDir, skillNames, { authoritative = false, backupDir = "", recordMaterializationTime = true } = {}) {
  const sources = skillSourceDirs();
  // Defense at the filesystem sink: web writes and run-time grant resolution already normalize
  // names, but legacy/manual config and direct callers must not turn a grant into `../` traversal.
  // A grant stored under a renamed bundled skill's OLD name resolves to the new one, so an
  // existing channel keeps the skill it was granted without an admin re-granting it.
  const reserved = new Set(["gateway-usage", "channel-memory"]);
  const grantNames = sanitizeSkillGrantNames(skillNames).map((n) => RENAMED_MANAGED_SKILLS[n] || n)
    .filter((name) => !authoritative || !reserved.has(name.toLowerCase()));
  // Dependencies (`requires:` in a catalog skill's frontmatter) are resolved HERE, at every
  // materialization, not only when a grant is written: a dependency that was still awaiting
  // review when the grant was made arrives the moment it is approved. Unknown names pass through
  // untouched for the host-folder fallback below.
  let safeSkillNames = grantNames;
  try {
    const { names, profile } = withDependencies(grantNames);
    // Dependencies that cannot be materialized yet (awaiting review, tombstoned, not in the
    // catalog) still go through the loop below so they are REPORTED as missing, never dropped.
    const pending = [
      ...profile.staged.map((e) => e.slug),
      ...profile.removed.map((e) => e.slug),
      ...profile.missingDependencies.map((m) => m.slug),
    ];
    safeSkillNames = [...new Set([...names, ...pending])];
  } catch {
    /* catalog unavailable — materialize the grants as given */
  }
  const enabled = [];
  const missing = [];
  const states = {};

  for (const name of safeSkillNames) {
    if (authoritative && reserved.has(name.toLowerCase())) continue;
    let result;
    try {
      result = await materializeSkill(skillsDir, name, { authoritative, backupDir, recordMaterializationTime });
    } catch (err) {
      if (authoritative) throw new Error(`Could not synchronize skill "${name}": ${err?.message || err}`, { cause: err });
      result = { state: "error", slug: name, error: err?.message || String(err) };
    }
    states[name] = result.state;
    if (result.state === "written" || result.state === "unchanged" || result.state === "project") {
      enabled.push(result.slug);
      continue;
    }
    if (result.state === "staged" || result.state === "removed") {
      missing.push(name);
      continue;
    }
    // Not in the catalog (or the catalog failed): the original host-folder copy path.
    const dest = path.join(skillsDir, name);
    if (!authoritative && await exists(dest)) {
      // A real granted skill wins over a library stub of the same name — replace the stub with it.
      if (!(await isLibraryStub(dest))) {
        enabled.push(name);
        continue;
      }
      await rm(dest, { recursive: true, force: true });
    }
    let copied = false;
    for (const dir of sources) {
      const src = path.join(dir, name);
      if (path.resolve(src) !== path.resolve(dest) && await exists(src)) {
        if (authoritative && (await realpath(src)) === (await realpath(dest).catch(() => path.resolve(dest)))) continue;
        if (authoritative) {
          const files = normalizeSkillFiles(await readSkillDirectory(src));
          const hash = hashSkillFiles(files);
          const revision = { id: `host:${hash}`, contentHash: hash, revisionNo: 1, version: "" };
          const fallback = await materializeSkill(skillsDir, name, {
            authoritative, backupDir, recordMaterializationTime, lookup: () => ({ slug: name }), bundleFor: () => ({ revision, files }),
          });
          states[name] = fallback.state;
          enabled.push(name);
          copied = true;
          break;
        }
        // dereference: the user's skills are often symlinks into an available_skills/ store;
        // copy the real content so the folder is self-contained (no broken relative links).
        await cp(src, dest, { recursive: true, dereference: true });
        await writeFile(path.join(dest, MANAGED_SKILL_MARKER), "gateway-owned\n");
        enabled.push(name);
        copied = true;
        break;
      }
    }
    if (!copied) missing.push(name);
  }

  // Revoke stale grants. Authoritative workspaces archive unmarked local entries; other callers
  // remove only copies bearing our marker. Reserved injected protocols are managed separately.
  // Runs AFTER materialization so a skill whose catalog slug differs from its grant name (a name
  // grant resolving to a slug) is kept under the slug it was written to.
  await pruneManagedSkills(skillsDir, authoritative ? [...enabled, ...reserved] : enabled, { authoritative, backupDir });
  return { enabled, missing, states };
}
