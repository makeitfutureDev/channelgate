---
title: Skill templates
description: Follow a centrally maintained workflow set while keeping local additions.
---

A skill template is a reusable selection of explicit skill slugs. Conversations follow its current contents live; a template edit changes subsequent requests in every conversation assigned to it.

## Preview and assign

Ask for the available templates rather than assuming a particular installation has a populated Development, Sales, or Marketing set:

```text
List the skill templates. Preview the Development template for this channel, including gained, kept, dropped skills and context cost.
```

`preview_skill_template` changes nothing. Its report separates the template's contribution from the effective context cost including organization grants. Assign with `set_channel_skill_template`; conversation members can do this without an approval card. The conversation must already be provisioned.

Assignment retains the conversation's own additional grants. Personal and organization grants remain independent. A missing or staged skill can appear in a template but cannot become active until the catalog has an approved usable revision.

## Maintain a shared template

Administrators manage templates in **Admin → Skills → Templates**. They can add or remove skills with `update_skill_template`. Members request an addition using `propose_skill_change` with `kind: "template"` and the template name; the administrator decides it in **Skills → Review**.

The template may include descriptive category metadata, but its active selection resolves from explicit skill slugs. Inspect the resolved list before assigning it.

## Override locally or stop following

Remove a template-provided skill with `remove_channel_skills` to deactivate it in this conversation alone. Adding it again reactivates it. Assign `template: "none"` to stop following the template while retaining explicit additions and channel-section skills. Future edits to the old template then stop affecting this conversation.

Related: [grants](/docs/features/skill-grants), [governance](/docs/features/skill-governance), and [template controls](/docs/controls/skills#list_skill_templates).
