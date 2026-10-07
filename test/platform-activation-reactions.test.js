import test from 'node:test';
import assert from 'node:assert/strict';
import { teamsReactionAction, teamsGraphReactionAction, teamsActivationFingerprint } from '../src/platforms/msteams/reactions.js';
import { normalizeActivity } from '../src/platforms/msteams/activity.js';
import { parseChatEvent } from '../src/platforms/googlechat/events.js';

test('Teams custom Unicode and reference IDs match independently of previous defaults', () => {
  for (const value of ['🚀', '1f680_rocket', ':1f680_rocket:']) assert.equal(teamsReactionAction(value, ['🚀']), 'engage');
  for (const value of ['like', '👍🏽', 'alien', '👽', '🤖', 'hearteyesrobot']) assert.equal(teamsReactionAction(value, ['🚀']), '');
  for (const value of ['🛑', 'stopsign']) assert.equal(teamsReactionAction(value, ['🚀']), 'stop');
  for (const value of ['✅', '2705_whiteheavycheckmark']) assert.equal(teamsReactionAction(value, ['🚀']), 'ack');
  assert.equal(teamsReactionAction('stop'), '', 'plain text does not create a new stop alias');
  assert.equal(teamsReactionAction('1f6d1_arbitrary'), '', 'new control aliases do not bypass introduction cutoffs');
});

test('Graph robot metadata respects the configured family without equating ordinary Heart eyes', () => {
  const robot = { reactionType: '😍', displayName: 'Heart eyes robot', reactionContentUrl: null };
  assert.equal(teamsGraphReactionAction(robot, ['hearteyesrobot']), 'engage');
  assert.equal(teamsGraphReactionAction(robot, ['alien']), '');
  assert.equal(teamsGraphReactionAction({ ...robot, displayName: 'Heart eyes' }, ['hearteyesrobot']), '');
  assert.equal(teamsGraphReactionAction({ ...robot, reactionContentUrl: 'https://custom.example/image' }, ['hearteyesrobot']), '');
  assert.equal(teamsGraphReactionAction({ reactionType: '😍' }, ['😍']), 'engage');
  assert.equal(teamsGraphReactionAction({ reactionType: '🚀' }, ['1f680_rocket']), 'engage');
  assert.equal(teamsGraphReactionAction({ reactionType: '❤️' }, ['heart']), 'engage');
  assert.equal(teamsGraphReactionAction({ reactionType: '👋🏽' }, ['1f44b_wavinghand-tone3']), 'engage');
});

test('equivalent Teams aliases and ordering yield the same configuration version', () => {
  assert.equal(teamsActivationFingerprint(['👽', '👍🏽', '🤖']), teamsActivationFingerprint(['robot_face', 'alien', 'like']));
  assert.equal(teamsActivationFingerprint(['🚀', '🚀']), teamsActivationFingerprint(['1f680_rocket']));
  assert.notEqual(teamsActivationFingerprint(['😍']), teamsActivationFingerprint(['hearteyesrobot']));
});

test('native Teams parsing receives a current activation selection and retains fixed controls', () => {
  const activity = { type: 'messageReaction', id: 'r1', replyToId: 'm1', from: { id: '29:reactor' }, conversation: { id: '19:test@thread.v2', conversationType: 'groupChat' } };
  for (const [type, expected] of [['🚀', 'engage'], ['hearteyesrobot', null], ['stopsign', 'stop'], ['2705_whiteheavycheckmark', 'ack']]) {
    const message = normalizeActivity({ ...activity, reactionsAdded: [{ type }] }, { activationReactions: ['🚀'] });
    assert.equal(message?.reactionAction ?? null, expected);
  }
});

test('Google Chat interaction transport does not mistake reaction events for messages', () => {
  assert.equal(parseChatEvent({ reaction: { emoji: { unicode: '🚀' } } }, { 'ce-type': 'google.workspace.chat.reaction.v1.created' }).type, 'unknown');
});
