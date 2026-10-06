---
title: Publishing skills to Git
description: Persist authored and approved workflows in a configured repository.
---

Publishing writes package revisions back to one configured Git destination. Import credentials and publishing credentials are separate, so access to a source does not automatically grant repository writes.

## Configure the destination

In **Admin → Skills → Sync settings → Publishing to Git**, set the repository, write-capable GitHub token, folder, and mode. An empty repository disables publishing. The default folder is `skills`, the default branch is `main`, and the default mode is `commit`; operators should choose the intended branch deliberately.

In commit mode, eligible create, update, and approval operations publish automatically. The catalog reports whether publication succeeded. If the publishing repository is also a source, the skill can be adopted by that source rather than remaining locally owned.

## Publish a pending revision

Channel managers or administrators can request `publish_skill` for a visible eligible skill. The action uses the existing destination; it cannot choose an arbitrary repository in the call.

```text
Publish the project-report skill's current revision to our configured skills repository. Report the repository, branch, folder, and any failure.
```

A successful result names the written files and deleted files. Plugin packages with executable files require mode-preserving publishing from the repository directly; the built-in Contents API publisher refuses them. Unsupported ownership, disabled publishing, missing credentials, and repository errors are returned as explicit failures or refusal reasons. A catalog save can succeed while the Git push fails; inspect both outcomes before claiming the package is backed up remotely.

## Keep synchronization safe

A writable repository update can remain pinned locally until its repository contains the expected bytes, preventing a subsequent sync from reverting it. Moving a skill between a channel section and the shared library can also move its published repository path.

For external sources this gateway cannot write, create a companion package instead of modifying the imported files. Publishing does not approve an arbitrary external revision or grant the package to other conversations.

Related: [authoring](/docs/features/skill-authoring), [scope](/docs/features/skill-governance), [synchronization](/docs/features/skill-synchronization), and [publish control](/docs/controls/skills#publish_skill).
