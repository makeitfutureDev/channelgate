import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { saveInboundAttachments } = await import('../src/platforms/attachments.js');

test('simultaneous flat group messages with the same upload name keep disjoint stable bytes', async () => {
  let downloads = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const makeMessage = (id, bytes) => ({
    platform: 'msteams', conversationId: 'teams:19:upload-fixture', kind: 'group', threadKey: '', messageId: id,
    attachments: [{ name: 'audio.wav', contentType: 'audio/wav', download: async () => {
      if (++downloads === 2) release();
      await bothStarted;
      return Buffer.from(bytes);
    } }],
  });
  const first = makeMessage('message-one', 'FIRST AUDIO');
  const second = makeMessage('message-two', 'SECOND AUDIO');
  const options = { slug: 'parallel-upload-fixture', meta: { platform: 'msteams' } };
  const [a, b] = await Promise.all([saveInboundAttachments(first, options), saveInboundAttachments(second, options)]);
  assert.deepEqual(a.skipped, []); assert.deepEqual(b.skipped, []);
  assert.notEqual(a.paths[0], b.paths[0]); assert.notEqual(path.dirname(a.paths[0]), path.dirname(b.paths[0]));
  assert.equal(path.basename(a.paths[0]), '1-audio.wav'); assert.equal(path.basename(b.paths[0]), '1-audio.wav');
  assert.equal(await readFile(a.paths[0], 'utf8'), 'FIRST AUDIO'); assert.equal(await readFile(b.paths[0], 'utf8'), 'SECOND AUDIO');
  assert.equal(first.threadKey, ''); assert.equal(second.threadKey, '', 'storage allocation does not create a native reply thread');
  const revision = await saveInboundAttachments({ ...first, attachments: [{ name: 'audio.wav', download: async () => Buffer.from('EDITED AUDIO') }] }, options);
  assert.notEqual(revision.paths[0], a.paths[0]); assert.equal(await readFile(a.paths[0], 'utf8'), 'FIRST AUDIO');
});
