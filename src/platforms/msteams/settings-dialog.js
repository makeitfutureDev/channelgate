// Native card dialogs need task/submit actions and task/continue responses. Keep this
// transport adaptation separate from controls rendering and its authorization rules.
import { adaptiveCardAttachment } from './cards.js';

function launcher(stateId, name, kind) {
  const files = kind === 'files';
  return { type: 'AdaptiveCard', version: '1.4', body: [
    { type: 'TextBlock', text: files ? 'Conversation files' : 'Conversation settings', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: files ? `Browse files for ${name || 'this conversation'} in a window inside Teams.` : `Manage ${name || 'this conversation'} in a settings window inside Teams.`, wrap: true },
  ], actions: [{ type: 'Action.Submit', title: files ? 'Open files' : 'Open settings', associatedInputs: 'none',
    data: { msteams: { type: 'task/fetch' }, cgAction: `${kind}.open`, stateId } }] };
}

export const settingsLauncher = (stateId, name) => launcher(stateId, name, 'settings');
export const filesLauncher = (stateId, name) => launcher(stateId, name, 'files');

function dialogActions(value) {
  if (Array.isArray(value)) return value.map(dialogActions);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'Action.Execute') {
    const { verb, fallback, ...action } = value;
    return { ...action, type: 'Action.Submit' };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dialogActions(item)]));
}

export function settingsDialogResponse(card, title = 'Conversation settings') {
  return { status: 200, body: { task: { type: 'continue', value: {
    title, width: 'large', height: 'large',
    card: adaptiveCardAttachment(dialogActions(card)),
  } } } };
}
