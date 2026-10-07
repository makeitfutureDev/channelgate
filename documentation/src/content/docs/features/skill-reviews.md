---
title: Skill review, history, and rollback
description: Approve proposals and source revisions while preserving a known working version.
---

There are two review queues: staged revisions delivered by sources in review mode, and proposals submitted by people or external clients. Neither silently replaces the approved package while waiting.

## Review incoming revisions

Open **Admin → Skills → Review**. Inspect the package files and requirements, then approve or reject the staged revision. Approval makes the whole package eligible for conversations that grant it; rejecting leaves the current approved revision in place. A plugin revision includes its executable components, so examine those alongside its written instructions.

## Handle a proposal

Members use `propose_skill_change` for changed files, feedback, promotion, deletion, or a template addition. External library clients with the `propose` scope can submit changed files or feedback. Administrators inspect pending proposals in the Review tab or with `list_skill_proposals`, then use `decide_skill_proposal`.

```text
Show pending skill proposals. Summarize what each would change and who would receive it before I decide.
```

Approving feedback closes the proposal. Approving a change creates a revision; a source-backed change may become a pinned local override. A promotion can move a personal or channel skill into the shared library, or grant an existing organization skill everywhere. A template decision changes all conversations following that template.

## Pin or roll back

Select the skill under **Admin → Skills** and inspect **Revisions**. The **pin** action selects an approved historical revision as the effective version. **follow current** removes the pin and resumes following the approved current revision. Pinning preserves the package bytes without rewriting an old revision.

For a source-backed skill, incoming synchronization can continue while a pin keeps the chosen revision effective. Check the pin and source state when an update seems missing.

## Remove without losing history

Catalog removal uses a tombstone and is restorable in the admin UI. Deactivating a conversation grant does not remove the catalog item. Exclusion persists across synchronization until an administrator explicitly restores it.

Related: [governance](/docs/features/skill-governance), [synchronization](/docs/features/skill-synchronization), and [review controls](/docs/controls/skills#propose_skill_change).
