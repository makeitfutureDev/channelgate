import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createGoogleChatConnector } = await import('../src/platforms/googlechat/connector.js');
const { chatCard, chatButtons, chatAction, chatLink, chatText } = await import('../src/platforms/googlechat/cards.js');
const { parseChatEvent, normalizeCardEvent } = await import('../src/platforms/googlechat/events.js');
const { googleChatActionData } = await import('../src/platforms/googlechat/controls.js');
const { googleChatAdapter } = await import('../src/platforms/googlechat.js');

const ENDPOINT = 'https://gw.example.com/api/googlechat/events';
const SPACE = 'spaces/AAA';
const card = () => chatCard('Settings', [chatText('x'), chatButtons([
  chatAction('Apply', 'settings.access.apply', 'state-1', { page: 'general' }),
  chatLink('Docs', 'https://example.com/docs'),
])]);
function fakeApi() {
  const calls = [];
  return { calls, api: {
    createMessage: async (space, body) => { calls.push(body); return { messageId: `${space}/messages/m1`, threadName: '' }; },
    patchMessage: async (name, body) => { calls.push(body); },
  } };
}
const actionsOf = cardsV2 => JSON.parse(JSON.stringify(cardsV2)).flatMap(c => c.card.sections.flatMap(s => s.widgets))
  .flatMap(w => w.buttonList?.buttons || []);

test('card actions are routed to the HTTP endpoint URL, keeping the action name as cgAction', async () => {
  let url = ENDPOINT;
  const { calls, api } = fakeApi();
  const connector = createGoogleChatConnector({ api, capabilities: googleChatAdapter.capabilities, actionEndpoint: () => url });
  await connector.postCard({ conversationId: SPACE, card: card(), text: 'Settings' });
  await connector.updateCard({ conversationId: SPACE, messageId: `${SPACE}/messages/m1`, card: card() });
  for (const body of calls) {
    const [apply, link] = actionsOf(body.cardsV2);
    assert.equal(apply.onClick.action.function, ENDPOINT);
    assert.equal(apply.onClick.action.parameters.find(p => p.key === 'cgAction').value, 'settings.access.apply');
    assert.deepEqual(link.onClick, { openLink: { url: 'https://example.com/docs' } });
  }
  url = '';
  await connector.postCard({ conversationId: SPACE, card: card() });
  assert.equal(actionsOf(calls.at(-1).cardsV2)[0].onClick.action.function, 'settings.access.apply');
});

test('an add-on click naming the endpoint URL resolves to the cgAction name', () => {
  const event = parseChatEvent({
    commonEventObject: { invokedFunction: ENDPOINT, parameters: { cgAction: 'settings.page', stateId: 'state-1', page: '"mcp"' } },
    chat: { user: { name: 'users/1', email: 'a@example.com' }, buttonClickedPayload: {
      space: { name: SPACE }, message: { name: `${SPACE}/messages/m1` } } },
  });
  const normalized = normalizeCardEvent(event);
  assert.equal(normalized.action.function, 'settings.page');
  assert.deepEqual({ ...googleChatActionData(normalized) }, { action: 'settings.page', data: Object.assign(Object.create(null), { stateId: 'state-1', page: 'mcp' }) });
});
