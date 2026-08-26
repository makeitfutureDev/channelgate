# Working in a git repository — one worktree per task

Multiple Slack threads can run in this same folder **at the same time**. If two of them edit the
same working tree, they overwrite each other's uncommitted changes — silently. The fix is git's
built-in isolation: each editing task works in its **own worktree on its own branch**, and only
merged results reach the shared branch. History, branches, and commits are shared instantly;
working files are not.

**If the project's own instruction file (its AGENTS.md / CLAUDE.md) defines a different git
convention, the project's convention wins.** These rules are the default for repos that don't
say otherwise.

## Step 0 — detect (every task)

Before your first file edit, check where you are:

```sh
git rev-parse --is-inside-work-tree 2>/dev/null
```

- Not a repo, or the task is **read-only** (questions, status checks, analysis) → none of this
  applies; work normally.
- A repo AND the task will create/modify/delete files tracked by it → follow the protocol below.
  Scratch output that doesn't belong to the repo (downloads, generated reports) is fine outside it.

## Step 1 — open a worktree for the task

```sh
git fetch origin                       # best-effort; skip if offline / no remote
grep -qx '.worktrees/' .git/info/exclude 2>/dev/null || echo '.worktrees/' >> .git/info/exclude
git worktree add -b <type>/<slug> .worktrees/<slug> origin/main
```

- `<type>/<slug>`: name the branch for the work — `feature/…`, `fix/…`, `docs/…`, or a short
  descriptive slug. If the branch already exists (another thread owns it), pick a different slug.
- Branch from `origin/main` when a remote exists, else from `main` (or the repo's default branch —
  `git symbolic-ref --short HEAD` in a fresh clone shows it).
- Worktrees live in `.worktrees/` **inside** the repo folder — your sandbox can't write outside
  it. The `info/exclude` line keeps them out of `git status` without touching the repo's
  `.gitignore`.
- The canonical checkout (the folder root) stays on `main`, clean. **Never switch its branch and
  never edit files there while a task worktree is open.**

## Step 2 — work inside the worktree

- Do ALL edits, test runs, and commits under `.worktrees/<slug>/…` — use paths inside the
  worktree, not the matching path at the repo root.
- Commit early and often; only committed work is safe from a concurrent thread.
- **Stage only your own changes.** Never `git add -A` / `git commit -a` — if files you didn't
  touch show up modified, another task is at work; leave them alone.
- Untracked artifacts (`node_modules`, build output) don't carry over — reinstall inside the
  worktree if the task needs to run anything.

## Step 3 — land (merge + push)

```sh
cd <repo root>                          # the canonical checkout, on main
git fetch origin && git merge --ff-only origin/main   # bring main current (skip without remote)
git merge --no-ff <type>/<slug>         # or --ff-only if main didn't move
git push origin main                    # when a remote is configured
```

- If `main` moved while you worked: first rebase your branch onto the new `main` **in the
  worktree**, resolve conflicts there, re-verify, then merge. Never resolve by dropping another
  task's changes — if `git diff main` shows deletions you didn't write, that's their landed work;
  rebase, don't revert.
- Re-run a proportionate check (tests/build) after any conflict resolution, before pushing.
- If the push is rejected or blocked, say so in your reply — don't leave landed commits silently
  unpushed.

## Step 4 — clean up (only after landing)

```sh
git merge-base --is-ancestor <type>/<slug> main   # exit 0 = safely merged
git worktree remove .worktrees/<slug>
git branch -d <type>/<slug>
```

**Never delete an unmerged branch or a worktree with uncommitted changes.** If the check fails,
leave both in place and report it.

**Remove a worktree with `git worktree remove`, never `rm -rf .worktrees/<slug>`.** A plain
directory delete leaves git's bookkeeping behind: `git worktree list` keeps listing the entry as
`prunable`, and `git branch -d` then refuses with *"cannot delete branch … used by worktree"*, so
landed branches pile up forever. Recover with:

```sh
git worktree prune                  # forget worktrees whose directory is already gone
git branch -d <type>/<slug>         # now succeeds
```

## Step 5 — report the change with inline-code paths

When you tell the user what you changed, put each file's path in inline code, relative to the
working folder, so it becomes a clickable `📄 name` footer button (see
`references/writing-replies.md`). Name the file in the **canonical checkout**, not the
`.worktrees/<slug>/…` copy — that path is gone once step 4 removes the worktree, and a path that
no longer exists yields no button at all:

```
✅ Rewrote `src/slack/footer.js`.
❌ Rewrote `.worktrees/fix-footer/src/slack/footer.js`.
```

## Session start — see what's open

Any session can inspect and tidy the shared state:

```sh
git worktree list      # open task worktrees
git branch -a --no-merged main    # branches with unlanded work
```

- A branch already merged into `main` whose worktree is still around → safe to clean up (step 4).
- An entry marked `prunable` — its directory is already gone, only the metadata is left. Run
  `git worktree prune` once, then judge the branch by the two rules above.
- An unmerged branch → another thread's work in progress, or an abandoned task. Don't merge or
  delete it blind; mention it to the user and ask.
