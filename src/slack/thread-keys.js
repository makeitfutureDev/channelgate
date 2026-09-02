// A run's `threadKey` is its SESSION key, which is not always a Slack thread. Scheduled runs use
// `sched-<id>-<ts>`, background agents `<realTs>::agent-<id>`, and API jobs their own shapes.
// Posting one of those as `thread_ts` makes Slack reject the call outright (invalid_thread_ts), so
// anything that posts into "the run's thread" must resolve it first. Kept in its own tiny module
// (rather than in approvals.js, which pulls in the whole run/engine graph) so the MCP tool servers
// — separate child processes — can share the exact same rule.
//
// A Slack message timestamp is "<seconds>.<microseconds>" — and ONLY that shape is accepted as a
// thread_ts.
export function isSlackTs(value) {
  return /^\d+\.\d+$/.test(String(value ?? ""));
}

// Resolve the real Slack thread for a session key: the key itself when it IS a ts, its `<ts>::`
// prefix when the key was derived from a real thread, and otherwise null — meaning "post this
// TOP-LEVEL in the channel", which is the only thing Slack will accept for a synthetic key.
export function slackThreadFor(threadKey) {
  const key = String(threadKey ?? "");
  if (isSlackTs(key)) return key;
  const head = key.split("::")[0];
  return isSlackTs(head) ? head : null;
}
