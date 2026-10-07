---
title: Skill grants and dependencies
description: Choose workflows for a person, conversation, or organization.
---

A grant decides which skill packages a future request receives. Effective access combines organization, conversation, and author-specific grants, including the conversation's live template and the dependencies declared by selected skills.

## Choose the scope

| Scope | Who changes it | Effect |
| --- | --- | --- |
| Personal | Approved person, for themselves | Their requests across conversations |
| Conversation | Members admitted to that conversation | Future requests in that conversation |
| Organization | Administrator | Every conversation |

Conversation members can add or deactivate their conversation's skills without an approval card. Personal changes also need no card. Announce a shared change so collaborators know their future requests have different instructions. Organization changes use the administrator control path.

```text
Add the project-report skill to this conversation. Explain any dependencies and context warnings.
```

Use **Slack Settings → Skills**, the conversation's Skills controls in the admin UI, or the `add_channel_skills` and `remove_channel_skills` tools. Changes take effect on the next message. `add_my_skills` and `remove_my_skills` affect only the verified requesting person; HTTP API runs have no personal catalog.

## Understand removal

Removing an explicit conversation grant leaves the catalog package intact. A template or channel-section skill is deactivated only here and can be reactivated by adding it again. Organization grants cannot be removed by a conversation member.

A dependency is not a separate grant. If a selected skill declares `requires: [another-skill]`, the required package loads with it. Removing that dependency by itself cannot detach it while the parent still requires it. Remove the parent or change its requirements through the appropriate authoring path.

## Keep the profile useful

`show_channel_skills` labels inherited sources and estimates always-on descriptions. The default soft warning is 6,000 tokens; it does not block a grant. Personal packages are delivered privately to their author's run rather than copied into the shared project skill folder.

Related: [templates](/docs/features/skill-templates), [usage](/docs/features/skill-usage), and [control reference](/docs/controls/skills).
