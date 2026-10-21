// Cards v2 helpers. All data-derived card text is escaped before Chat interprets HTML.
// https://developers.google.com/workspace/chat/api/reference/rest/v1/cards
export const MAX_CHAT_CARD_WIDGETS = 100;
export const MAX_CHAT_CARD_BYTES = 28_000;
export const MAX_CHAT_SELECTION_ITEMS = 100;
export const escapeCardText = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const chatText = value => ({ textParagraph: { text: escapeCardText(String(value ?? '').slice(0, 2400)).replace(/\r?\n/g, '<br>') } });
export const chatButtons = buttons => ({ buttonList: { buttons } });
export function chatAction(label, action, stateId, data = {}) {
  return { text: String(label).slice(0, 80), onClick: { action: { function: String(action), parameters: [
    { key: 'cgAction', value: String(action) },
    { key: 'stateId', value: String(stateId) },
    ...Object.entries(data).filter(([key, value]) => key !== 'stateId' && key !== 'cgAction' && value !== undefined).map(([key, value]) => ({ key, value: JSON.stringify(value) })),
  ] } } };
}
export function chatLink(label, url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Card links require an HTTP(S) address.');
  return { text: String(label).slice(0, 80), onClick: { openLink: { url: parsed.href } } };
}
export function chatCard(title, widgets) {
  const card = { header: { title: String(title).slice(0, 120) }, sections: [{ widgets: widgets.length ? widgets : [chatText('No items.')] }] };
  return validateChatCard(card);
}
export function validateChatCard(card) {
  const count = (card.sections || []).reduce((sum, section) => sum + (section.widgets || []).length, 0);
  if (count > MAX_CHAT_CARD_WIDGETS || Buffer.byteLength(JSON.stringify(card)) > MAX_CHAT_CARD_BYTES) throw new Error('This Google Chat card is too large. Open a smaller page.');
  for (const section of card.sections || []) for (const widget of section.widgets || []) {
    if (widget.selectionInput?.items?.length > MAX_CHAT_SELECTION_ITEMS) throw new Error('This Google Chat selector has too many choices.');
  }
  return card;
}

// A Chat app built as a Workspace add-on dispatches a click to the URL in `action.function`; a short
// name there makes Chat answer "unable to process your request" before the gateway sees the click.
// Every action already carries its name as the `cgAction` parameter, so routing only swaps the
// function for the endpoint URL. A standalone Chat app echoes the function back, so it is safe there.
export function routeCardActions(card, endpoint) {
  if (!endpoint) return card;
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item);
    if (out.onClick?.action && typeof out.onClick.action === 'object') out.onClick = { ...out.onClick, action: { ...out.onClick.action, function: endpoint } };
    return out;
  };
  return walk(card);
}

// Shared settings policy renders its small, declarative Adaptive Card UI. Converting that UI
// keeps authorization and runtime transactions in one place while using Chat-native controls.
export function adaptiveSettingsToChat(card) {
  function action(item) {
    if (item.type === 'Action.OpenUrl') return chatLink(item.title, item.url);
    // Adaptive `associatedInputs: none` (Deny) must not carry the card's typed inputs; Chat always
    // submits every form input, so the action itself records that its inputs are ignored.
    return chatAction(item.title, item.data?.cgAction || item.verb, item.data?.stateId,
      { ...(item.data || {}), ...(item.associatedInputs === 'none' ? { cgInputs: 'none' } : {}) });
  }
  function widgets(items) {
    return (items || []).flatMap(item => {
      if (!item) return [];
      if (item.type === 'TextBlock') {
        const result = chatText(item.text);
        if (item.weight === 'Bolder') result.textParagraph.text = `<b>${result.textParagraph.text}</b>`;
        return [result];
      }
      if (item.type === 'ActionSet') return [chatButtons(item.actions.map(action))];
      if (item.type === 'ColumnSet') return item.columns.flatMap(column => widgets(column.items));
      if (item.type === 'Input.ChoiceSet') {
        const choices = item.choices || [];
        if (choices.length > MAX_CHAT_SELECTION_ITEMS) throw new Error('This Google Chat selector has too many choices.');
        const selected = item.isMultiSelect ? String(item.value || '').split(',') : [String(item.value || '')];
        return [{ selectionInput: { name: item.id, label: String(item.label || '').slice(0, 100), type: item.isMultiSelect ? 'MULTI_SELECT' : 'DROPDOWN',
          items: choices.map(choice => ({ text: String(choice.title).slice(0, 100), value: String(choice.value), selected: selected.includes(String(choice.value)) })) } }];
      }
      if (item.type === 'Input.Text') return [{ textInput: { name: item.id, label: String(item.label || '').slice(0, 100), value: String(item.value || ''), type: item.isMultiline ? 'MULTIPLE_LINE' : 'SINGLE_LINE' } }];
      throw new Error('Unsupported Google Chat settings control.');
    });
  }
  // The first Bolder TextBlock is the Adaptive title; it becomes the Chat header, not a repeat.
  const titled = card.body?.[0]?.type === 'TextBlock' && card.body[0].weight === 'Bolder';
  const body = titled ? card.body.slice(1) : card.body;
  return chatCard(titled ? card.body[0].text : 'Channel settings', [...widgets(body), ...(card.actions?.length ? [chatButtons(card.actions.map(action))] : [])]);
}

// A deliberate, value-free explanation a requester may see privately. Anything else (REST
// failures, parser errors) collapses to the generic retry guidance so no detail leaks.
export class GoogleChatControlError extends Error {}
export const controlError = message => new GoogleChatControlError(message);
