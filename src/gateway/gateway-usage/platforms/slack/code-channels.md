# Slack code channels

A **code channel** is a dedicated Slack channel for ONE task: the whole channel is one agent
session, people in it talk to you without @-mentioning, Slack shows a **Code** tab (the task
branch's diff), up to five **artifact tabs** you publish, a **context bar** (folder, branch,
repository, pull request) and a channel-wide **Stop** button. Teammates join, review and answer
in the same place. When the task is done the channel is archived (history and tabs stay readable
and searchable).

## Opening one — only when asked

Open a code channel ONLY when the requester explicitly asks for one ("open a code channel for
this", "let's do this in a code channel", "work on it in its own channel"). Never open one on your
own initiative, and never from a DM or from inside another code channel.

- `gateway` → `open_code_channel` with `task` (one or two sentences — it becomes the session's
  purpose and the first turn's brief), optionally `name`, `mode` and `private`.
- The call posts an **approval card** in this thread; the requester (or an admin) confirms. Say
  that you asked and end your turn. Nothing is created until the click.
- On approval the gateway creates the channel (linked to this message, so members here may join),
  registers it as a child of this channel — same folder, access policy, secrets, skills, mode —
  and **starts the first turn there itself**. You do not need to post in it.
- `mode`: `auto` (default) decides from the folder — a **git repository gets its own task branch
  `code/<slug>` in a worktree at `.worktrees/<slug>`** inside the folder; anything else works in
  the channel's files. `worktree` / `in_place` force either; the requester's words decide
  ("in place", "on a new branch").
- A refusal names the cause: Slack Code not enabled for the app or workspace (`feature_disabled`),
  the requester's account lacking the feature, the missing `code_channels:manage` scope, or an
  origin that is a DM / Slack Connect channel. Report it as such — it is not something to retry
  around.

## Working inside one

Your run preamble says `[Slack code channel]` and names the task, the origin channel, and the
files you work on. Then:

- **Work on the task branch** when one exists: every path, edit, test run and commit under the
  worktree. Never edit the checkout root. If the preamble says the worktree could not be created,
  open it yourself first (`references/git-repos.md`) and tell the user.
- **Replies are top-level channel messages**, not thread replies (a reply inside a thread someone
  started stays in that thread). Keep them short: questions, decisions, progress notes. The work
  itself goes into the tabs.
- **The Code tab refreshes itself** after each of your turns with the worktree's diff against the
  base (committed and uncommitted tracked changes; new files once `git add`ed). Force it with
  `update_code_channel {refresh_diff:true}`.
- **Publish artifacts** with `gateway` → `update_code_channel`:
  - `view: {type:"html", key:"preview.html", content:"<!doctype html>…", name:"Preview"}` — a
    complete, self-contained HTML document (rendered sandboxed; external resources are blocked).
  - `view: {type:"block_kit", key:"plan", blocks:[…]}` — an interactive Block Kit view.
  - `view: {type:"pull_request", pr_url:"https://github.com/…/pull/123"}` — once you opened a PR;
    the context bar gets a **Pull request** link too.
  - `view: {type:"canvas", key:"notes", canvas_id:"F…"}` — a canvas you created (Composio).
  - `context_items: [{key, label, icon, url}]` — extra context-bar items (five in total, the
    defaults included; icons: branch, folder, hierarchy, life-ring, link, globe, terminal, code,
    search, lock).
  - `title` — rename the session (and the channel).
  Same `key` → the tab is replaced, not duplicated. Five tabs maximum.
- **Everyone there is a participant.** Answer messages aimed at you even without a mention; skip
  the ones clearly meant for a teammate. The channel inherits the origin's access policy, so
  anyone Slack let in but the gateway does not authorize is refused like anywhere else.
- **Stop** (Slack's button, `stop`, 🛑) cancels everything running in the channel.
- Clarification questions and approvals post their cards top-level here; otherwise nothing changes.

## Finishing

When the task is complete, post a wrap-up (what was done, where the branch or PR is, what is left)
and ask whether to archive. Only when the requester agrees call `gateway` →
`archive_code_channel` with `summary` (the wrap-up text; Slack shares it back into the origin
thread). That posts an approval card anyone working in the channel can confirm. The task branch
and worktree stay on disk — archiving never deletes work. Do not open a new code channel from an
archived one; ask in the origin channel.
