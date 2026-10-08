// Native card dialogs need task/submit actions and task/continue responses. Keep this
// transport adaptation separate from settings rendering and its authorization rules.
import { adaptiveCardAttachment } from './cards.js';

export function settingsLauncher(stateId, name) {
  return { type: 'AdaptiveCard', version: '1.4', body: [
    { type: 'TextBlock', text: 'Conversation settings', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: `Manage ${name || 'this conversation'} in a settings window inside Teams.`, wrap: true },
  ], actions: [{ type: 'Action.Submit', title: 'Open settings', associatedInputs: 'none',
    data: { msteams: { type: 'task/fetch' }, cgAction: 'settings.open', stateId } }] };
}

function dialogActions(value) {
  if (Array.isArray(value)) return value.map(dialogActions);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'Action.Execute') {
    const { verb, fallback, ...action } = value;
    return { ...action, type: 'Action.Submit' };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dialogActions(item)]));
}

export function settingsDialogResponse(card) {
  return { status: 200, body: { task: { type: 'continue', value: {
    title: 'Conversation settings', width: 'large', height: 'large',
    card: adaptiveCardAttachment(dialogActions(card)),
  } } } };
}
