// Card payloads carry data, never authority. Identity comes only from the verified activity envelope.
import { messageCard, ADAPTIVE_CARD_TYPE } from "./cards.js";
import { splitConversationId } from "./activity.js";
import { isConversationId, validateServiceUrl } from "./api.js";
const SCOPES = new Set(["thread", "conversation", "channel", "user", "gateway", "once", "always", "forever"]);
const RESERVED = new Set(["__proto__", "prototype", "constructor", "actorId", "userId", "senderId", "conversationId", "tenantId", "serviceUrl", "aadObjectId"]);
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function isTeamsCardInteraction(activity) {
  if (activity?.type === "invoke") return true;
  return activity?.type === "message" && plain(activity.value) && typeof activity.value.cgAction === "string";
}
export function normalizeTeamsInteraction(activity) {
  const value = activity?.value;
  if (!plain(value)) throw new Error("Card input must be an object");
  const execute = activity.type === "invoke" && activity.name === "adaptiveCard/action";
  if (activity.type === "invoke" && !execute && !["task/submit", "composeExtension/submitAction"].includes(activity.name)) throw new Error("Unsupported Teams invoke action");
  const supplied = execute ? value.action?.data : value.data && plain(value.data) ? value.data : value;
  if (!plain(supplied) || Buffer.byteLength(JSON.stringify(supplied)) > 16_384) throw new Error("Invalid card form data");
  const verb = execute ? value.action?.verb || supplied.cgAction : supplied.cgAction;
  if (typeof verb !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/.test(verb)) throw new Error("Invalid card action");
  if (execute && value.action.type !== "Action.Execute" && value.action.type !== "Action.Submit") throw new Error("Unsupported card action type");
  const data = {};
  for (const [key, item] of Object.entries(supplied)) {
    if (RESERVED.has(key) || key === "cgAction" || key === "msteams") continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null) throw new Error("Card inputs must be scalar values");
    if (typeof item === "string" && item.length > 8000) throw new Error("Card input is too long");
    data[key] = item;
  }
  if (Object.hasOwn(data, "scope") && !SCOPES.has(data.scope)) throw new Error("Unsupported card scope");
  const actorId = activity.from?.id;
  const split = splitConversationId(activity.conversation?.id);
  if (!actorId || !isConversationId(actorId) || !split.conversationId || !isConversationId(split.conversationId)) throw new Error("Card action requires a complete actor and conversation");
  const serviceUrl = validateServiceUrl(activity.serviceUrl);
  if (!serviceUrl) throw new Error("Invalid card service URL");
  return { action: verb, data, actorId, aadObjectId: activity.from?.aadObjectId || "", conversationId: `teams:${split.conversationId}`,
    nativeConversationId: split.conversationId, threadKey: split.threadKey, tenantId: activity.channelData?.tenant?.id || activity.conversation?.tenantId || "",
    serviceUrl, activityId: String(activity.id || ""), responseMessageId: String(activity.replyToId || "") };
}
export function createTeamsInteractionHandler({ dispatch, authorize = null } = {}) {
  if (typeof dispatch !== "function") throw new TypeError("Teams card interaction dispatch is required");
  return async activity => {
    let interaction;
    try { interaction = normalizeTeamsInteraction(activity); }
    catch { return { status: 400, body: { error: "Invalid card action" } }; }
    // The business dispatcher must check approval ownership and current channel/user permissions.
    try {
      if (authorize && !await authorize(interaction)) return { status: 403, body: { error: "Not allowed" } };
      return await dispatch(interaction);
    } catch {
      return { status: 200, body: { statusCode: 200, type: ADAPTIVE_CARD_TYPE,
        value: messageCard({ title: "Action could not be completed", text: "Reopen the controls to check the current state before trying again." }) } };
    }
  };
}
