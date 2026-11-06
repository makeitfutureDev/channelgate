// Process-local admission while the daemon verifies Slack membership. Persisted `botMembership`
// also carries the pending state to MCP children, which cannot see this process's gate.
let enabled = false;
let epoch = 0;
const verified = new Set();

export function isSlackMembershipChannel(meta = {}) {
  return (!meta.platform || meta.platform === "slack") && !meta.isDM && meta.type !== "im"
    && /^[CG][A-Z0-9_]+$/.test(meta.channelId || "");
}

export function invalidateSlackMembership() {
  enabled = true;
  verified.clear();
  return ++epoch;
}
export function slackMembershipEpoch() { return epoch; }
export function confirmSlackMembership(channelId, expectedEpoch = epoch) {
  if (expectedEpoch !== epoch) return false;
  verified.add(channelId);
  return true;
}
export function revokeSlackMembership(channelId) { verified.delete(channelId); }
export function assertChannelMembership(meta = {}) {
  if (isSlackMembershipChannel(meta) && (meta.botMembership === "pending" || (enabled && !verified.has(meta.channelId)))) {
    throw Object.assign(new Error("Slack channel membership has not been verified. Configuration updates are paused until Slack reconnects and membership is confirmed."),
      { code: "channel_membership_unverified", status: 409, statusCode: 409 });
  }
}
