// The one unattended-reply delivery path (the 2026-08 restructure notes (internal repo) Phase 1). Every daemon-side
// automation that posts a finished run's answer into Slack — scheduler, background continuations,
// self-diagnosis, restart recovery, API runs — goes through deliverResult instead of hand-rolling
// the same sequence: mdToMrkdwn escapes model-authored <!channel>/<@U…> control sequences (an
// unattended run is the easiest prompt-injection target), resolveMentions restores sanctioned
// "@Name" pings, and postChunkedReply splits long answers instead of hard-truncating them (and
// falls back to "_(no output)_" on an empty reply). This is also the gateway/ side's single
// dependency on slack/ for result delivery — a second transport would be another deliver
// implementation, not five new call sites.
import { formatOutboundFor } from "../platforms/registry.js";
import { postFormatted } from "../platforms/connector.js";
import { getDirectory } from "./directory.js";
import { mdToMrkdwn, resolveMentions } from "./format.js";
import { answerImageBlocks, shareAnswerImageFiles } from "./images.js";
import { isSlackInvalidBlocksError, postChunkedReply } from "./util.js";
import { footerBlocks, footerButtons, footerText, menuBlocks, noticeWithMenuBlocks } from "./footer.js";
import { asConnector, postNotice } from "../platforms/notify.js";
import { slackThreadFor } from "./thread-keys.js";

export async function deliverResult(client, { channel, threadKey, result, dir, footer = false, trustedPrefix = "", uploadFile } = {}) {
  if (client?.platform && typeof client.post === "function") {
    const directory = dir !== undefined ? dir : await client.directory(channel).catch(() => null);
    const formatted = formatOutboundFor(client.platform, result?.content || "", { directory });
    // The prefix is renderer-specific trusted markup; do not carry Slack controls onto other
    // platforms. Scheduling on those platforms currently delivers without a broadcast mention.
    return postFormatted(client, { conversationId: channel, threadKey, formatted,
      footer: footer ? footerText(result) : "" });
  }
  // Callers that already resolved the workspace directory pass it; otherwise fetch (best-effort —
  // mentions simply stay plain text without it).
  const directory = dir !== undefined ? dir : await getDirectory(client).catch(() => null);
  // The prefix is gateway-authored control markup. Add it only after hostile model content has
  // passed through the normal control-sequence defanging pipeline.
  const md = `${trustedPrefix}${resolveMentions(mdToMrkdwn(result?.content || ""), directory).trim()}`.trim();
  const answerBlocks = answerImageBlocks(result?.content || "");
  // Every answer ends with the reply menu. An automation post has no Slack requester, so the menu
  // is unbound and opens under the clicker's own authorization (footer.js). It rides the answer's
  // last message when that fits one section — a channel-level scheduled post must not grow a second
  // top-level message — and a trailer below a longer one.
  const threadTs = slackThreadFor(threadKey) || "";
  const context = { channel, threadTs };
  const buttons = footerButtons(result, context);
  const trailer = footer ? footerBlocks(result, context) : buttons.length ? [{ type: "actions", elements: buttons }] : null;
  await postChunkedReply(client, channel, threadTs, md, footer ? footerText(result) : "", buttons, { footerBlocks: trailer, answerBlocks });
  await shareAnswerImageFiles({ markdown: result?.content || "", cwd: result?.cwd, channel, threadTs, uploadFile });
}

// A gateway-authored notice that ENDS a reply — a failed run, a stopped one — carries the same menu
// an answer does. Slack only: another surface gets the plain text through postNotice, which drops
// Block Kit it cannot render. A notice too long for one section posts plainly with the menu in its
// own message below; a rejected menu never costs the notice itself.
export async function postNoticeWithMenu(client, { channel, threadKey = "", text, authorId = "" } = {}) {
  const context = { channel, threadTs: slackThreadFor(threadKey) || "", authorId };
  const blocks = noticeWithMenuBlocks(text, context);
  if (blocks) {
    try {
      return await postNotice(client, { conversationId: channel, threadKey, text, blocks });
    } catch (error) {
      if (!isSlackInvalidBlocksError(error)) throw error;
      return postNotice(client, { conversationId: channel, threadKey, text });
    }
  }
  const posted = await postNotice(client, { conversationId: channel, threadKey, text });
  const menu = menuBlocks(context);
  if (menu.length && asConnector(client)?.capabilities?.richCards === "block-kit") {
    await postNotice(client, { conversationId: channel, threadKey, text: "Menu: Files, Variables, Settings", blocks: menu })
      .catch(() => {});
  }
  return posted;
}
