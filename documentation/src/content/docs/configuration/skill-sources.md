---
title: Skill sources and templates
description: Import, review, publish, and grant reusable skills and plugins.
---

The skills catalog stores reusable instructions and their supporting files as versioned revisions. Importing a skill makes it available in the catalog; granting it determines which conversations or people receive it. Templates collect skills into a reusable selection that conversations can follow.

## Add a source

Open **Skills → Sources → + Add source** in the admin interface.

1. Choose **GitHub repository** or **Other ChannelGate**.
2. Give the source a label and URL, such as `https://github.com/example-team/agent-skills/tree/main/skills`.
3. Add the source's token if private access is needed. For another gateway, use an access token minted there with sync scope.
4. Choose **review — stage every change for approval** or **auto — activate on sync**.
5. Select **Add and sync**, inspect the imported files, and approve staged revisions in **Review** when using review mode.

Host folder sources are also supported through the skill-source tools/API. **Skills → Sync settings → Re-import host folders** imports operator folders. A host source directory is not a folder the ordinary channel agent can necessarily access.

| Control | Verified default or effect |
| --- | --- |
| Sync interval | 60 minutes; `0` disables periodic sync |
| Context soft cap | 6,000 tokens of active skill descriptions; a warning threshold, not a hard content limit |
| Source sync enabled | Pauses or resumes that source's updates |
| Pin revision | Keeps a Git source at the selected commit |
| Review changes | New revisions wait for approval; existing approved revision remains active |
| Activate automatically | Source revisions become active on sync |

## Grant skills to a conversation

Under **Conversations → Skills**, choose **Skill template** and any additional skills. The conversation follows the template's current selections, so future template edits reach it automatically. Its extra skills remain separate. Organization, conversation, and personal grants are combined for each run; dependencies named in `requires` accompany their parent skill.

Members can adjust their conversation's skills. Administrators manage organization grants, reusable templates, and source governance. **Enabled**, **Discoverable**, and **Mandatory** are different catalog flags: making a skill discoverable does not itself make it mandatory everywhere.

## Publishing and webhooks

**Skills → Sync settings → Publishing to Git** has a repository, publishing token, folder, and mode. An empty repository disables publishing; the default folder is `skills`. Keep publishing credentials separate from read-only source tokens.

For faster source updates, configure **GitHub webhook** with a secret and register its displayed endpoint on the repository. It needs a reachable public gateway URL. Do not paste webhook secrets into a skill's instructions.

## Effects and limits

Approved revisions and grants are resolved on subsequent messages without restarting. A conflicting skill name owned by another source is reported rather than silently replaced. Plugin packages are reviewed as one item, including their executable components, and still have engine-specific compatibility requirements.

See [Skills](/docs/features/skills), [Plugins](/docs/features/plugins), and the [technical skills reference](/docs/skills).
