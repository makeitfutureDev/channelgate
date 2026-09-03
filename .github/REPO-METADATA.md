# GitHub repository metadata

The "About" box, the topic list and the social preview are SEO surface, not decoration: the
description and topics are what GitHub search, Google and the awesome-list crawlers read. This file
is the source of truth for them, so a launch-day change is a diff here plus one command.

> **Repository URL.** Everything below uses `https://github.com/makeitfutureDev/channelgate` — the
> public repository (private until the launch gates clear). If it ever moves, update this file and
> the README in the same commit so every occurrence stays identical.

## About description (≤ 350 characters)

```text
The governed AI agent gateway for your Slack, Microsoft Teams and Google Chat channels. A self-hosted daemon that runs Claude Code or Codex inside a sandboxed folder per conversation, with per-author credentials, an MCP allowlist, schedules, background jobs and an admin UI. Source-available fair-code.
```

## Website

```text
https://makeitfuture.com/channelgate/
```

## Topics

`slack-bot` · `microsoft-teams` · `google-chat` · `claude-code` · `codex` · `mcp` · `ai-agents` ·
`self-hosted` · `fair-code` · `agent-gateway`

Ten is GitHub's practical display limit in the About box; adding an eleventh pushes one out of
sight. Each maps to a keyword cluster from the release plan — the chat surfaces, the harnesses, the
protocol, the category, the hosting model and the licensing model.

## Apply it

Run once at launch, from a checkout, with `gh` authenticated as `makeitfutureDev`:

```bash
gh repo edit makeitfutureDev/channelgate \
  --description "The governed AI agent gateway for your Slack, Microsoft Teams and Google Chat channels. A self-hosted daemon that runs Claude Code or Codex inside a sandboxed folder per conversation, with per-author credentials, an MCP allowlist, schedules, background jobs and an admin UI. Source-available fair-code." \
  --homepage "https://makeitfuture.com/channelgate/" \
  --add-topic slack-bot \
  --add-topic microsoft-teams \
  --add-topic google-chat \
  --add-topic claude-code \
  --add-topic codex \
  --add-topic mcp \
  --add-topic ai-agents \
  --add-topic self-hosted \
  --add-topic fair-code \
  --add-topic agent-gateway \
  --enable-discussions
```

Verify with `gh repo view makeitfutureDev/channelgate --json description,homepageUrl,repositoryTopics`.

## Social preview image

`gh` cannot set it — it is a manual upload. A **1280 × 640 px** PNG belongs at
[`docs/assets/social-preview.png`](../docs/assets/social-preview.png) (not created yet; the spec is
in [`docs/assets/README.md`](../docs/assets/README.md)) and is uploaded in
**Settings → General → Social preview**. Without one, GitHub unfurls the owner avatar and the repo
name, which is what every unbranded repository looks like in a Slack or X preview.

## Launch checklist

- [ ] Description and homepage applied with the command above.
- [ ] All ten topics present, no stray ones.
- [ ] Discussions enabled (the developer audience's landing spot per the release plan).
- [ ] `docs/assets/social-preview.png` created and uploaded in repository settings.
- [ ] Repository URL swapped everywhere if the repository was renamed.
