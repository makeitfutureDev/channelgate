// The ONE root every file-facing door resolves a channel's relative paths against: the effective
// working folder plus the channel's admin-declared additional folders as named mounts
// (src/slack/file-explorer.js explorerRoot, src/gateway/extra-folders.js). The Slack explorer,
// the browser download/edit/upload grants, public links, Composio staging, mail attachments and
// the workspace read tools all take it, so a file under `@mounts/<name>/…` is reachable from each
// of them with the same confinement as the working folder, and a read-only mount refuses writes
// on every one of those doors. Lives apart from folders.js (which extra-folders.js imports) and
// from file-explorer.js (kept free of daemon state) so neither closes an import cycle.
import { effectiveWorkDir } from "./folders.js";
import { explorerRoot } from "../slack/file-explorer.js";

export function channelFileRoot(slug, meta = {}) {
  const record = { ...(meta || {}), _slug: slug };
  return explorerRoot(effectiveWorkDir(slug, record), record.extraFolders);
}
