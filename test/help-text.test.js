import { test } from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT } from "../src/slack/help.js";
import { TEAMS_HELP_TEXT, createTeamsHelpCard } from "../src/platforms/msteams/help.js";
import { adaptiveCardAttachment } from '../src/platforms/msteams/cards.js';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { teamsAdapter } = await import('../src/platforms/msteams.js');

test("Teams /help includes practical workflows and its supported commands", () => {
  for (const expected of [
    '**How to use me**', '`@agent /help`', 'quote the original message', '👽 Alien',
    'Heart eyes robot', '👍 Like', 'Smile robot', '🛑 Stop sign', 'Tick button (Checkmark button)',
    'typing a code as a message does not add a reaction', 'Acknowledge a tracked reminder', 'Removing a reaction does not reopen',
    'local Whisper', 'Only the run author or an administrator', 'requests for the same session queue',
    'allowed drives and Microsoft permissions', '10 MB', 'Public URL', 'personal chat',
    'Stored credential values are never shown', 'Composio', 'list skills', 'remember that …',
    'always …', 'gateway-usage', 'channel-memory', 'remind me in 2 hours', 'list schedules',
    'delete schedule <id>', 'run it in the background', 'Resume',
    '`/help`', '`/settings`', '`/files [folder]`', '`/secrets`', '`/sendfile <path>`',
    '`/status`', '`/model [engine] [model|default]`', '`/effort [level|default]`',
    '`/stop`', '`/cancel`', '`/clear`',
  ]) assert.ok(TEAMS_HELP_TEXT.includes(expected), `Teams guide missing: ${expected}`);

  // These are Slack-specific controls; Teams has session queues and its own native console.
  assert.doesNotMatch(TEAMS_HELP_TEXT, /\/(?:menu|sudo|fork|delete|pending|context|compact|mode|next|update|resume)\b/);
  assert.doesNotMatch(TEAMS_HELP_TEXT, /Slack|Steer Conversation|Generate transcript|📂 button|:robot_face:|:octagonal_sign:|:white_check_mark:|🤖/);
});

test("Teams help survives the platform formatter within its message budget", () => {
  const { chunks } = teamsAdapter.formatOutbound(TEAMS_HELP_TEXT);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.length <= teamsAdapter.capabilities.maxMessageChars);
  assert.match(chunks[0].text, /How to use me/);
  assert.match(chunks[0].text, /All commands/);
  assert.match(chunks[0].text, /\/clear/);
  assert.match(chunks[0].text, /How to use me\*\*\n\nAsk a question/);
  assert.match(chunks[0].text, /\n\n`\/clear`/);
});

// Recursively inspect visible and expandable content without depending on the card layout.
function cardText(value) {
  if (Array.isArray(value)) return value.flatMap(cardText);
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'RichTextBlock') return [value.inlines.map(run => run.text).join('')];
  if (value.type === 'TextBlock') return [value.text];
  if (value.type === 'Action.ToggleVisibility') return [value.title];
  return Object.values(value).flatMap(cardText);
}

test('Teams help starts with a compact quick start and keeps the full guide in expandable topics', () => {
  const card = createTeamsHelpCard();
  assert.equal(adaptiveCardAttachment(card).contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.body[0].text, 'How to use me');
  assert.equal(card.body[0].size, 'Large');
  const visible = cardText(card.body.filter(item => item.isVisible !== false)).join(' ');
  assert.ok(visible.length < 1200, 'Initial card should stay scannable');
  for (const command of ['/model', '/settings', '/files', '/stop']) assert.ok(visible.includes(command));
  assert.ok(visible.includes('quote the original message'));
  assert.doesNotMatch(visible, /Whisper|Composio|hearteyesrobot|2705_whiteheavycheckmark/);

  const normalize = text => text.replace(/[`*]/g, '').split(/\s+/).filter(Boolean);
  const expected = TEAMS_HELP_TEXT.replace('**All commands**', 'Explore the guide Select a topic to expand or collapse it. All commands');
  assert.deepEqual(normalize(cardText(card).join(' ')), normalize(expected));
  assert.ok(!JSON.stringify(card).includes('`'), 'Commands use native monospace runs');
});

test('Teams help topic controls toggle existing hidden sections without submitting commands', () => {
  const card = createTeamsHelpCard();
  const actions = card.body.flatMap(item => item.actions || []);
  assert.equal(actions.length, 6);
  const ids = new Set();
  for (const action of actions) {
    assert.equal(action.type, 'Action.ToggleVisibility');
    assert.equal(action.targetElements.length, 1);
    const id = action.targetElements[0];
    assert.ok(!ids.has(id)); ids.add(id);
    const section = card.body.find(item => item.id === id);
    assert.equal(section?.type, 'Container');
    assert.equal(section.isVisible, false);
    assert.ok(section.items.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(card), /Action\.(?:Execute|Submit)|Input\./);
});

test("/help explains the gateway's essential user workflows", () => {
  const essentials = [
    "`@agent your request`",
    "react 🤖",
    "`@agent stop`",
    "react 🛑",
    "📂 button",
    "set my Composio token",
    "list skills",
    "`remember that …`",
    "`gateway-usage`",
    "`channel-memory`",
    "remind me in 2 hours",
    "list schedules",
    "run it in the background",
    "voice clip",
    "transcribed locally",
    "large-v3-turbo",
    "Slack transcript",
    "Generate transcript",
    "`/status`",
    "`/menu`",
    "`/pending`",
  ];

  for (const expected of essentials) assert.match(HELP_TEXT, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("/help explains optional local voice transcription and Slack fallback", () => {
  assert.match(HELP_TEXT, /voice clip/i);
  assert.match(HELP_TEXT, /@mention.*🤖/i);
  assert.match(HELP_TEXT, /transcribed locally/i);
  assert.match(HELP_TEXT, /Slack transcript/i);
  assert.match(HELP_TEXT, /Generate transcript/i);
  assert.match(HELP_TEXT, /raw audio.*Claude|Claude.*raw audio/i);
});

test("/help distinguishes thread stops from the top-level /stop command", () => {
  // The mention gate drops an un-mentioned channel message before the stop check, so the guide
  // must not promise that a bare `stop` works in a channel thread (it only does in a DM).
  assert.match(HELP_TEXT, /send `@agent stop`/);
  assert.match(HELP_TEXT, /bare `stop` needs no mention only in a DM/);
  assert.doesNotMatch(HELP_TEXT, /type `stop` in that thread/);
  assert.match(HELP_TEXT, /`\/stop` at top level stops every active run/);
  assert.match(HELP_TEXT, /choose \*Steer Conversation\*, \*Add to Queue\*, or \*Cancel Request\*/i);
  assert.match(HELP_TEXT, /choice card disappears after a valid selection/i);
  assert.match(HELP_TEXT, /`\/next <message>`.*queues directly/i);
});

test("/help describes creating files and broad UTF-8 text editing", () => {
  assert.match(HELP_TEXT, /create new files/i);
  assert.match(HELP_TEXT, /UTF-8 text files.*including `\.env`/i);
  assert.match(HELP_TEXT, /Worker\/Auto/i);
});

test("help does not advertise the removed files command", () => {
  assert.doesNotMatch(HELP_TEXT, /\/files/);
});

test('Teams help reflects the selected activation emojis in cards and text', async () => {
  const { teamsHelpText } = await import('../src/platforms/msteams/help.js');
  const text = teamsHelpText(['🚀']);
  assert.match(text, /configured activation reactions.*🚀/);
  assert.doesNotMatch(text, /choose 👽|Like .*starts a request/);
  assert.match(text, /Stop sign/);
  const runs = cardText(createTeamsHelpCard(['🚀'])).join(' ');
  assert.match(runs, /🚀/);
  assert.doesNotMatch(runs, /Alien/);
});

test('Teams help distinguishes disabled activation from named and custom reactions', async () => {
  const { teamsHelpText } = await import('../src/platforms/msteams/help.js');
  const disabled = teamsHelpText([]);
  assert.match(disabled, /No activation reactions are configured/);
  assert.doesNotMatch(disabled, /Alien|Heart eyes robot|Smile robot|👍 Like/);
  assert.match(disabled, /Stop sign/);
  const selected = teamsHelpText(['alien', 'smilerobot', 'custom-reaction']);
  assert.match(selected, /👽 Alien, Smile robot, custom-reaction/);
  assert.doesNotMatch(selected, /Heart eyes robot|👍 Like/);
  adaptiveCardAttachment(createTeamsHelpCard(['alien', 'smilerobot', 'custom-reaction']));
});
