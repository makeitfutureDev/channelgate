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
    '**How to use me**', '`@agent /help`', 'quote the original message', 'choose **Heart eyes robot**',
    'Heart eyes robot — `hearteyesrobot`', 'Stop sign — `stopsign`',
    'Tick button (Checkmark button) — `2705_whiteheavycheckmark`',
    'typing a code as a message does not add a reaction', 'Tick button acknowledges a tracked reminder', 'Removing a reaction does not reopen',
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
  assert.match(chunks[0].text, /Commands/);
  assert.match(chunks[0].text, /\/clear/);
  assert.match(chunks[0].text, /How to use me\*\*\n\nIn a personal chat/);
  assert.match(chunks[0].text, /\n\n• `\/clear`/);
});

test('Teams help card separates headings, paragraphs, emoji and commands without losing content', () => {
  const card = createTeamsHelpCard();
  assert.equal(adaptiveCardAttachment(card).contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.body[0].text, 'How to use me');
  assert.equal(card.body[0].size, 'Large');
  const headings = card.body.filter(item => item.type === 'TextBlock').map(item => item.text);
  assert.ok(headings.includes('Reaction names'));
  assert.ok(headings.includes('Open files'));
  assert.equal(headings.at(-1), 'Commands');
  const rows = card.body.filter(item => item.type === 'RichTextBlock');
  const plain = item => item.inlines.map(run => run.text).join('');
  const expected = TEAMS_HELP_TEXT.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
  // Compare all words, ignoring only heading bullets/colons: the card may style, never truncate.
  const words = text => text.replace(/[•:]/g, '').split(/\s+/).filter(Boolean);
  assert.deepEqual(words(card.body.map(item => item.text || plain(item)).join(' ')), words(expected));
  assert.equal(rows.filter(item => /^• \/.* — /.test(plain(item))).length, 10);
  assert.equal(rows.filter(item => /^(?:Heart eyes robot|🛑 Stop sign|✅ Tick button).* — /.test(plain(item))).length, 3);
  assert.ok(rows.some(item => item.inlines.some(run => run.text === '/help' && run.fontType === 'Monospace')));
  assert.ok(!JSON.stringify(card).includes('`'));
  assert.equal(card.actions, undefined);
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
