// Slack code channels (docs.slack.dev/ai/slack-code): a dedicated, semi-ephemeral Slack channel an
// agent opens for ONE task, where the whole channel is one agent session. This module is the
// platform-neutral half — what a code channel IS to the gateway: a CHILD conversation of the
// channel it was opened from. It inherits that origin's work folder, access policy, secrets,
// skills and mode on every read (so a rotation or a revoked guest in the origin reaches the code
// channel immediately), keeps its own Slack identity, sessions and container, and optionally works
// on a task branch in a git worktree INSIDE the origin folder — the repository's own
// one-worktree-per-task rule, made visible. The Slack half (creating the channel, the views, the
// context bar, archiving) is src/slack/code-channels.js; the tools are src/mcp/tools/code-channels.js.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getChannelMeta, patchChannelMeta } from "../config/store.js";
import { effectiveWorkDir } from "./folders.js";

const run = promisify(execFile);

// The one session key of a code channel. Not a Slack ts on purpose: slackThreadFor() resolves it to
// null, which is how every reply, card and notice lands TOP-LEVEL in the channel (Slack's contract
// for code channels), and how the runKey `<slug>::code-channel` stays stable across messages.
export const CODE_CHANNEL_SESSION_KEY = "code-channel";
export const CODE_CHANNEL_MODES = Object.freeze(["worktree", "in_place"]);
export const CODE_CHANNEL_WORKTREES_DIR = ".worktrees";
export const CODE_CHANNEL_BRANCH_PREFIX = "code/";
// Slack caps a diff/html view at 1,000,000 bytes (content_too_large above). Stay under it.
export const CODE_CHANNEL_VIEW_MAX_BYTES = 950_000;
const GIT_TIMEOUT_MS = 30_000;
const TASK_MAX_CHARS = 2_000;
const GW_INSTRUCTION_MARKER = "GATEWAY-INSTRUCTIONS:START";

export function isCodeChannelMeta(meta) {
  return Boolean(meta?.codeChannel && typeof meta.codeChannel === "object" && meta.codeChannel.originSlug);
}

// The session key and the Slack reply target for a message in a code channel. One session for the
// whole channel; a reply goes into the thread the PERSON used, else top-level.
export function codeChannelReplyTarget(event = {}) {
  const threadTs = String(event?.thread_ts || "").trim();
  return { threadKey: CODE_CHANNEL_SESSION_KEY, replyTs: /^\d+\.\d+$/.test(threadTs) ? threadTs : "" };
}

export function normalizeCodeChannelMode(value) {
  const v = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (v === "worktree" || v === "branch" || v === "new_branch") return "worktree";
  if (v === "in_place" || v === "inplace" || v === "shared" || v === "channel_files") return "in_place";
  return "auto";
}

// Is `dir` the top of a git working tree (a `.git` directory or a worktree's `.git` file)?
export function isGitRoot(dir) {
  try {
    const info = statSync(path.join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

// Which files a code channel works on. A repository gets its own task branch in a worktree inside
// the origin folder (the diff tab shows exactly that branch's change); anything else works in the
// channel's normal files. The requester may force either; "worktree" on a non-repository falls
// back to in_place and says so.
export function decideCodeChannelMode(originDir, requested = "auto") {
  const mode = normalizeCodeChannelMode(requested);
  const repo = isGitRoot(originDir);
  if (mode === "in_place") return { mode: "in_place", repo, forced: true };
  if (!repo) return { mode: "in_place", repo, forced: false, note: mode === "worktree" ? "the folder is not a git repository, so the code channel works in the channel's files" : "" };
  return { mode: "worktree", repo, forced: mode === "worktree" };
}

// The code channel's own identity fields; everything else is the origin's.
const OWN_FIELDS = ["channelId", "name", "type", "platform", "codeChannel", "engine", "model", "effort", "codexAuthSource", "approvedEngines", "workspaceOwnerSlug", "workspaceOrigin", "workspaceLink"];

// Project the ORIGIN's meta onto a code channel: the origin's policy, secrets, skills, engine and
// switches, this channel's own identity, the origin's effective folder as `workDir` (so the same
// host directory is mounted) and the `codeChannel` record. Never a DM, never a DM template.
export function inheritedCodeChannelMeta(originMeta, own) {
  const originSlug = own?.codeChannel?.originSlug || originMeta?._slug || "";
  const base = { ...(originMeta || {}) };
  delete base._slug;
  delete base.dmUserId;
  const next = {
    ...base,
    isDM: false,
    template: "",
    workDir: originSlug ? effectiveWorkDir(originSlug, { ...base, cleanMode: false }) : (base.workDir || ""),
  };
  for (const field of OWN_FIELDS) if (own?.[field] !== undefined) next[field] = own[field];
  return next;
}

function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Re-project the origin's current meta onto a code channel's row. Called on every inbound message
// and every run, so a change in the origin (a rotated secret, a narrowed access policy, a new skill
// grant) reaches the code channel without anyone touching it. Writes only when something differs.
// Returns the effective meta (the stored copy when the origin is gone, so the channel keeps working
// on its last known policy rather than widening to defaults).
export async function syncCodeChannelMeta(slug, meta) {
  if (!isCodeChannelMeta(meta)) return meta;
  const originMeta = await getChannelMeta(meta.codeChannel.originSlug);
  if (!originMeta) return meta;
  const own = Object.fromEntries(OWN_FIELDS.map((f) => [f, meta[f]]));
  const next = inheritedCodeChannelMeta(originMeta, own);
  if (sameRecord(next, meta)) return meta;
  return (await patchChannelMeta(slug, () => next)) || next;
}

// ── Host-side git: the task worktree and its diff ────────────────────────────────────────────
// The daemon owns the origin folder (it provisions it), so creating the worktree here is a file
// operation on its own directory, deterministic and independent of the model. Every call is
// execFile with an argument array (no shell), rooted in the origin folder, and bounded in time.

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(stdout);
}

// The ref a task branch starts from: the checkout's upstream when it has one (what the
// repository's own worktree rule says), else the exact commit at its HEAD — never the symbolic
// "HEAD", which inside the worktree would follow the task branch itself and hide its commits.
async function baseRefFor(root) {
  try {
    const upstream = (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
    if (upstream) return upstream;
  } catch {
    /* no upstream */
  }
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function excludeWorktreesDir(root) {
  try {
    const gitDir = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
    const exclude = path.resolve(root, gitDir, "info", "exclude");
    const current = await readFile(exclude, "utf8").catch(() => "");
    if (!current.split("\n").includes(`${CODE_CHANNEL_WORKTREES_DIR}/`)) await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${CODE_CHANNEL_WORKTREES_DIR}/\n`);
  } catch {
    /* best-effort; a visible .worktrees/ in git status is cosmetic */
  }
}

/**
 * Create the task branch and worktree for a code channel inside the origin repository.
 * @returns {Promise<{ok:true, worktree:string, branch:string, baseRef:string}|{ok:false, error:string}>}
 */
export async function prepareCodeChannelWorktree({ root, slug }) {
  const safeSlug = String(slug || "").replace(/[^a-z0-9._-]/gi, "-").replace(/^-+|-+$/g, "") || "task";
  const worktree = path.join(root, CODE_CHANNEL_WORKTREES_DIR, safeSlug);
  try {
    if (!isGitRoot(root)) return { ok: false, error: "not a git repository" };
    const baseRef = await baseRefFor(root);
    await excludeWorktreesDir(root);
    let lastError = "";
    for (let n = 0; n < 3; n++) {
      const branch = `${CODE_CHANNEL_BRANCH_PREFIX}${safeSlug}${n ? `-${n + 1}` : ""}`;
      try {
        await git(root, ["worktree", "add", "-b", branch, worktree, baseRef]);
        return { ok: true, worktree, branch, baseRef };
      } catch (error) {
        lastError = String(error?.stderr || error?.message || error).trim();
        // A stale branch from an earlier channel of the same name: try the next suffix. Anything
        // else (the worktree path exists, a locked index, no git binary) is final.
        if (!/a branch named .* already exists/i.test(lastError)) break;
      }
    }
    return { ok: false, error: lastError || "git worktree add failed" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function truncateDiff(text, max = CODE_CHANNEL_VIEW_MAX_BYTES) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return text;
  let cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  cut = cut.slice(0, cut.lastIndexOf("\n") + 1 || cut.length);
  return `${cut}\n# … diff truncated by the gateway (${bytes} bytes; Slack shows at most ${max}).\n`;
}

/**
 * The unified diff of a code channel's worktree against its base: committed and uncommitted
 * tracked changes alike. The gateway's own managed instruction block (CLAUDE.md/AGENTS.md) is
 * left out when it is the only change to that file — it is channel plumbing, not the task's work.
 * @returns {Promise<{ok:true, diff:string, base:string, head:string, files:number}|{ok:false, error:string}>}
 */
export async function computeCodeChannelDiff({ worktree, baseRef = "HEAD", branch = "" }) {
  try {
    if (!worktree || !isGitRoot(worktree)) return { ok: false, error: "the task worktree does not exist" };
    let mergeBase = baseRef;
    try {
      mergeBase = (await git(worktree, ["merge-base", baseRef, "HEAD"])).trim() || baseRef;
    } catch {
      /* detached or unknown base: diff against the ref itself */
    }
    const changed = (await git(worktree, ["diff", "--name-only", mergeBase, "--"])).split("\n").map((s) => s.trim()).filter(Boolean);
    const exclude = [];
    for (const file of changed.filter((f) => f === "CLAUDE.md" || f === "AGENTS.md")) {
      const fileDiff = await git(worktree, ["diff", "--no-color", "--no-ext-diff", mergeBase, "--", file]);
      if (fileDiff.includes(GW_INSTRUCTION_MARKER)) exclude.push(`:(exclude)${file}`);
    }
    const diff = await git(worktree, ["diff", "--no-color", "--no-ext-diff", mergeBase, "--", ".", ...exclude]);
    const head = branch || (await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return { ok: true, diff: truncateDiff(diff), base: baseRef, head, files: changed.length - exclude.length };
  } catch (error) {
    return { ok: false, error: String(error?.stderr || error?.message || error).trim() };
  }
}

// "owner/repo" + an https URL for the origin remote, when it is a GitHub/GitLab-shaped remote.
export async function describeRepository(root) {
  try {
    const url = (await git(root, ["remote", "get-url", "origin"])).trim();
    const m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    if (!m) return { url: "", label: path.basename(root) };
    return { url: `https://${m[1]}/${m[2]}`, label: m[2] };
  } catch {
    return { url: "", label: path.basename(root) };
  }
}

export function sanitizeTask(text) {
  return String(text || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TASK_MAX_CHARS);
}

// The per-attempt preamble a run in a code channel receives: where it is, what the task is, which
// files it works on, how to reply here, and the one place the artifacts go.
export function codeChannelPreamble(meta) {
  if (!isCodeChannelMeta(meta)) return "";
  const cc = meta.codeChannel;
  const where = cc.mode === "worktree" && cc.worktree
    ? `Work ONLY inside the task worktree \`${cc.worktree}\` (branch \`${cc.branch}\`, branched from \`${cc.baseRef || "HEAD"}\`); use paths under it, commit there, and never edit the checkout root. Its diff against the base is published to the channel's Code tab automatically after each of your turns (commit or leave changes in the tree — both show; new files show once \`git add\`ed).`
    : cc.mode === "worktree"
      ? `The task was meant to run on its own branch, but the worktree could not be created (${cc.worktreeError || "unknown reason"}). Follow the git-repos guide: open \`.worktrees/<slug>\` on branch \`${CODE_CHANNEL_BRANCH_PREFIX}<slug>\` yourself before the first edit, then tell the user.`
      : "Work in this channel's normal files (the folder is not a git repository, or the requester asked for in-place work).";
  return `[Slack code channel] You are working in the Slack code channel <#${meta.channelId}> (${meta.name || "code channel"}), opened by <@${cc.createdBy}> from <#${cc.originChannelId}> for ONE task:\n` +
    `Task: ${cc.task || "(see the opening message)"}\n` +
    `${where}\n` +
    `Replies here are posted top-level in the channel (not in a thread) and everyone in it can read and answer you without @-mentioning; keep channel messages for questions, decisions and short progress notes, and put the work itself in the channel's artifact tabs with the gateway tool \`update_code_channel\` (an HTML preview, a Block Kit view, a pull-request link, extra context-bar items, a session title). ` +
    `When the task is complete, post a wrap-up and ask whether to archive the channel; call \`archive_code_channel\` only when the requester agrees. Do not open another code channel from here.\n`;
}

// The prompt that starts the first turn in a new code channel.
export function codeChannelKickoffPrompt(cc) {
  return `This code channel was just opened for the following task. Begin the work now: inspect what is needed, outline your plan in one short message, then proceed.\n\nTask: ${cc.task || "(see the origin message)"}`;
}
