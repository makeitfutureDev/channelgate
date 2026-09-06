// The one unattended-reply delivery path (the 2026-08 restructure notes (internal repo) Phase 1). Every daemon-side
// automation that posts a finished run's answer into Slack — scheduler, background continuations,
// self-diagnosis, restart recovery, API runs — goes through deliverResult instead of hand-rolling
// the same sequence: mdToMrkdwn escapes model-authored <!channel>/<@U…> control sequences (an
// unattended run is the easiest prompt-injection target), resolveMentions restores sanctioned
// "@Name" pings, and postChunkedReply splits long answers instead of hard-truncating them (and
// falls back to "_(no output)_" on an empty reply). This is also the gateway/ side's single
// dependency on slack/ for result delivery — a second transport would be another deliver
// implementation, not five new call sites.
import { getDirectory } from "./directory.js";
import { mdToMrkdwn, resolveMentions } from "./format.js";
import { postChunkedReply } from "./util.js";
import { footerText, resumeButton } from "./footer.js";

export async function deliverResult(client, { channel, threadKey, result, dir, footer = false, trustedPrefix = "" } = {}) {
  // Callers that already resolved the workspace directory pass it; otherwise fetch (best-effort —
  // mentions simply stay plain text without it).
  const directory = dir !== undefined ? dir : await getDirectory(client).catch(() => null);
  // The prefix is gateway-authored control markup. Add it only after hostile model content has
  // passed through the normal control-sequence defanging pipeline.
  const md = `${trustedPrefix}${resolveMentions(mdToMrkdwn(result?.content || ""), directory).trim()}`.trim();
  if (footer) {
    await postChunkedReply(client, channel, threadKey, md, footerText(result), resumeButton(result.cwd, result.sessionId, result.engine));
  } else {
    await postChunkedReply(client, channel, threadKey, md);
  }
}
