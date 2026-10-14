// Native Teams cards. Text and lists are bounded at rendering, with an explicit preview notice.
export const ADAPTIVE_CARD_TYPE = "application/vnd.microsoft.card.adaptive";
const SCOPES = new Set(["thread", "conversation", "channel", "user", "gateway", "once", "always", "forever"]);
const MAX_CARD_BYTES = 24_000;
export function boundedText(value, max = 2400) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 35))}\n[Preview truncated — open details]` : text;
}
const block = (text, extra = {}) => ({ type: "TextBlock", text: boundedText(text), wrap: true, ...extra });
const card = (title, body = [], actions = []) => ({ $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [block(title, { weight: "Bolder", size: "Medium" }), ...body], ...(actions.length ? { actions } : {}) });
function action(title, verb, data = {}, associatedInputs = "auto") {
  const payload = { ...data, cgAction: verb };
  return { type: "Action.Execute", title: boundedText(title, 80), verb, data: payload, associatedInputs,
    fallback: { type: "Action.Submit", title: boundedText(title, 80), data: payload, associatedInputs } };
}
function choices(values) {
  return values.slice(0, 50).map(item => typeof item === "string"
    ? { title: boundedText(item, 100), value: item }
    : { title: boundedText(item.title || item.label || item.name || item.id || item.value, 100), value: String(item.value || item.id || item.model || "") })
    .filter(item => item.value && item.value.length <= 200);
}
export function adaptiveCardAttachment(value) {
  if (value?.type !== "AdaptiveCard" || !Array.isArray(value.body)) throw new Error("A valid AdaptiveCard is required");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CARD_BYTES) throw new Error("Adaptive card exceeds the supported preview size");
  return { contentType: ADAPTIVE_CARD_TYPE, content: value };
}
export function messageCard({ title = "ChannelGate", text = "" } = {}) { return card(title, [block(text)]); }
export function modelSettingsCard({ catalog = [], current = {}, actionData = {} } = {}) {
  const models = choices(catalog);
  const body = [block("Choose a model and where to apply it."),
    { type: "Input.ChoiceSet", id: "model", label: "Model", style: "compact", isRequired: true, errorMessage: "Choose a model", choices: models,
      ...(models.some(item => item.value === current.model) ? { value: current.model } : {}) },
    { type: "Input.ChoiceSet", id: "scope", label: "Apply to", style: "compact", value: ["thread", "channel", "gateway"].includes(current.scope) ? current.scope : "thread",
      choices: [{ title: "This task", value: "thread" }, { title: "This conversation", value: "channel" }, { title: "Gateway default", value: "gateway" }] }];
  if (catalog.length > 50) body.push(block("Model list truncated to 50 choices. Use settings to view the complete catalog."));
  return card("Model settings", body, [action("Save", "model.save", actionData)]);
}
export function approvalCard({ id, title = "Approval requested", details = "", target = "", approvalType = "", scopes = ["once"], actionData = {} } = {}) {
  const allowed = scopes.map(item => typeof item === "string" ? item : item.value).filter(scope => SCOPES.has(scope));
  if (!id || !allowed.length) throw new Error("Approval requires an id and supported scopes");
  const body = [block(details || target || approvalType || "Review this request before approving.")];
  if (allowed.length > 1) body.push({ type: "Input.ChoiceSet", id: "scope", label: "Approval scope", choices: allowed.map(value => ({ title: value, value })), value: allowed[0], isRequired: true });
  body.push({ type: "Input.Text", id: "comment", label: "Optional changes requested (a comment refuses the current action)", isMultiline: true, maxLength: 4000 });
  const data = { ...actionData, id: String(id), ...(allowed.length === 1 ? { scope: allowed[0] } : {}) };
  return card(title, body, [action("Approve", "approval.respond", { ...data, decision: "approve" }),
    action("Deny", "approval.respond", { ...data, decision: "deny" }, "none"),
    action("Request changes", "approval.respond", { ...data, decision: "deny" })]);
}
export function settingsCard({ title = "Settings", description = "Choose a setting.", items = [], actionData = {} } = {}) {
  const shown = items.slice(0, 8);
  const body = [block(description)];
  if (items.length > shown.length) body.push(block("Settings list truncated. Open settings for the remaining options."));
  return card(title, body, shown.map(item => action(item.title || item.label || item.id, item.action || "settings.open", { ...actionData, section: item.id || item.section })));
}
export function formCard({ title = "Settings", fields = [], action: verb = "settings.save", actionData = {} } = {}) {
  if (fields.length > 12) throw new Error("A card form supports at most 12 fields");
  const seen = new Set();
  const body = fields.map(field => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.id) || seen.has(field.id) || ["cgAction", "actorId", "userId", "senderId", "conversationId", "tenantId", "serviceUrl"].includes(field.id)) throw new Error("Invalid or reserved card field id");
    seen.add(field.id);
    const base = { id: field.id, label: boundedText(field.label || field.id, 100), isRequired: Boolean(field.required) };
    if (field.choices) return { type: "Input.ChoiceSet", ...base, choices: choices(field.choices), value: String(field.value || ""), style: "compact" };
    if (field.type === "toggle") return { type: "Input.Toggle", ...base, title: base.label, value: field.value ? "true" : "false", valueOn: "true", valueOff: "false" };
    return { type: "Input.Text", ...base, value: boundedText(field.value || "", 1000), maxLength: Math.min(Number(field.maxLength) || 1000, 4000), isMultiline: Boolean(field.multiline) };
  });
  return card(title, body, [action("Save", verb, actionData)]);
}
