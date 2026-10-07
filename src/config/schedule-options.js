import { capabilitiesFor, platformOr } from "../platforms/registry.js";
import { platformOfConversation } from "../platforms/ids.js";

// Shared validation for MCP and admin edits. An invalid fixed-thread key must never degrade
// into a top-level post. Platform-specific target shapes belong to the platform adapter.
export function validateScheduleOptions(s) {
  if (s.kind === "reminder" && (s.executionVisibility === "silent" || s.resultPolicy === "on-result" || s.failureNotify === false || s.delivery === "thread")) {
    return "Silent/result-only/thread options are for agent tasks, not reminders.";
  }
  if (s.delivery !== "thread") return "";
  const platform = platformOfConversation(s.channelId);
  const key = s.deliveryThread;
  if (typeof key !== "string" || !key || key.length > 500 || /[\s<>]/.test(key) ||
      capabilitiesFor(platform).threading !== "native" || !platformOr(platform).validDeliveryThread?.(key, s.channelId)) {
    return "Thread delivery requires a valid existing thread ID in THIS conversation; synthetic session keys are not delivery threads.";
  }
  return "";
}
