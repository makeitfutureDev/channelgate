// Session writers must agree on the current native history namespace. In particular, a validated
// /resume adoption already came from this target's mount view and must not look like legacy
// private history when run.js applies its next-turn scope/history guard.
import { engineSessionState } from "../engines/registry.js";

export function sharesChannelHistory(target, engine) {
  return target?.container?.sharedHistory === true && engineSessionState(engine)?.channelHistory === true;
}

export function sessionRuntimeStamp(target, engine) {
  return JSON.stringify({
    backend: target?.backend || "host",
    scope: target?.runtimeScope,
    history: sharesChannelHistory(target, engine) ? "channel-v1" : "",
    container: target?.container?.name || "",
    fingerprint: target?.runtime?.fingerprint(target),
    image: target?.container?.image || "",
  });
}
