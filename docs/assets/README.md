# `docs/assets/`

Binary assets referenced by the README and by the GitHub repository settings. Two files are
expected here; **neither is in the repository yet**, and no placeholder stand-in should be
committed in their place — a broken image is more honest than a fake one.

| File | Size | Where it is used | Status |
| --- | --- | --- | --- |
| `demo.gif` | 45 seconds, ≤ 8 MB, ≥ 1000 px wide | The README hero demo block | not created |
| `social-preview.png` | 1280 × 640 px, PNG | GitHub social preview (repo Settings → General → Social preview) and the site's OpenGraph card | not created |

## `demo.gif` — capture spec

One unbroken 45-second screen capture of a real run, no titles and no voice-over:

1. A teammate `@mentions` the bot in a Slack channel with a task that touches a file and a tool.
2. The streamed placeholder appears, then the live ✓ / ◐ / ○ checklist as the agent works.
3. The final reply lands in the thread with its time · tokens · cost footer.

Rules: a scratch workspace only — no real customer names, channel names, avatars, email addresses,
tokens or file contents. Crop to the message column; a full desktop shot is unreadable at README
width. Keep it under 8 MB so GitHub renders it inline instead of linking it.

When it exists, replace the demo note in [`../../README.md`](../../README.md) with:

```markdown
![ChannelGate answering in a Slack thread](docs/assets/demo.gif)
```

## `social-preview.png` — spec

1280 × 640 px (GitHub crops to roughly 1280 × 640 and downscales for the card). Keep the wordmark
and the one-line tagline inside the middle 80 % so nothing is clipped in a Slack/X unfurl. Upload it
in **Settings → General → Social preview**; GitHub stores it on its own CDN, so committing the file
here is for versioning, not for serving. See [`../../.github/REPO-METADATA.md`](../../.github/REPO-METADATA.md).
