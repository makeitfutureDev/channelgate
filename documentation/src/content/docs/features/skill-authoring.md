---
title: Creating and updating skills
description: Turn a repeatable procedure into a versioned workflow package.
---

Create a skill when instructions should be reused across future requests. Its entry point is `SKILL.md` with `name` and `description` frontmatter. Supporting references, scripts, and assets belong inside the same package.

## Start with a concrete workflow

```text
Create a skill for our weekly status report: gather updates, identify blocked work, and prepare a draft for review. Keep it in this channel and document the required connected apps.
```

A channel request defaults to a channel skill, automatically active there and editable by admitted members. A DM request defaults to a personal skill, active only in its author's requests. An organization skill requires an explicit organization request: administrators create it directly; a member's request creates a usable local skill and files a promotion proposal.

A useful entry point explains when to trigger, what inputs are required, how to handle uncertainty, which accounts to use, and what deliverable to produce. Catalog packages support up to 400 files, 2 MiB decoded per file, and 16 MiB total; package paths must be relative and cannot traverse upward. Keep account credentials out of package files. Refer to configured connections or environment-variable names instead.

## Update a package

`update_skill` accepts changed files and optional removals; unspecified files are retained. Identical content produces no new revision. An authorized change creates an immutable content-hashed revision and becomes available on subsequent messages.

Personal owners edit their own skills; channel members edit their channel skills; administrators edit organization skills. A member's organization edit becomes a proposal. File removals cannot be carried through that automatic proposal path; include the removal request in the note for the reviewer.

## Respect external ownership

Bundled packages, host folders, peer gateways, and repositories this gateway cannot write to are not edited in place. Create a companion skill with `requires: [original-slug]` and the additional procedure instead. A configured writable publishing source can accept updates through its repository path.

**Admin → Skills** also offers **New skill**, file inspection, history, and scope controls. Skills are instructions, not extra tool permissions. Both Claude and Codex can consume granted packages; executable plugin components have additional engine and authorization limits.

Related: [reviews](/docs/features/skill-reviews), [publishing](/docs/features/skill-publishing), [plugins](/docs/features/plugins), and [authoring controls](/docs/controls/skills#create_skill).
