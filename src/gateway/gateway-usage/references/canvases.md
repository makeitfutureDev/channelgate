# Canvases

A Slack **canvas** is a rich, persistent document attached to a channel or shared standalone —
good for notes, specs, runbooks, meeting docs, or anything longer than a message that should live
on and be edited. Canvases are created through the explicitly selected Composio account:
`composio-user` for the requester's Slack or `composio-agent` for your own Slack.

## How
- Find Composio's Slack canvas action (create / edit / read a canvas) via Composio's tool
  discovery and use it — don't assume a fixed tool name.
- Canvas content is a rich document (headings, lists, checkboxes, tables), so unlike a Slack
  *message* you can use full structure here.

## Prerequisite: selected Composio account with Slack connected
Follow the identity rules in `SKILL.md` → “Tool identities”. “My canvas” uses `composio-user`;
“your canvas” uses `composio-agent`. Ask if ambiguous, and never substitute one account for an
explicitly requested unavailable account.

## When to use a canvas vs alternatives
- **A living document people edit** (runbook, spec, notes) → canvas (Composio).
- **A compact read-only table in the thread** → post a native data table with `slack_post_table`;
  for a big/wide export, upload CSV/TSV with `slack_upload_snippet` — see `references/tables.md`.
- **Structured rows people edit** (tasks, tracker) → a Slack List (`references/tables.md`).
- **A quick answer** → just reply in the thread (`references/writing-replies.md`).

## Tip
After creating a canvas, drop a short message in the thread with what you made and a pointer to
it, so people know it exists.
