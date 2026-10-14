// The signed conversation chooses the native tool surface for either engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
const scratch = ensureTestEnv();
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc } = await import('../src/mcp/gateway-server.js');
const { registerTransport, unregisterTransport } = await import('../src/platforms/live.js');
const { setUser, upsertChannelEntry, saveChannelMeta } = await import('../src/config/store.js');
const { GATEWAY_TOOL_NAMES } = await import('../src/gateway/mcp-catalog.js');
const { requestApproval, lookupApproval, handlePlatformApproval } = await import('../src/slack/approvals.js');
const { saveSettings } = await import('../src/config/settings.js');
const { listPublicFileLinks } = await import('../src/gateway/public-file-links.js');

async function session(channelId, engine, run, options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer(ctxFromClaims({ channelId, slug: 'tool-source', authorId: '29:file-owner',
    threadKey: '123456', origin: 'platform_foreground', principalTrusted: true, engine }, options));
  const client = new Client({ name: 'file-tool-test', version: '1.0.0' });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await run(client);
  } finally { await client.close(); await server.close(); }
}
for (const engine of ['claude', 'codex']) test(`${engine}: Teams and Chat advertise native source-scoped file controls without Slack tools`, async () => {
  const channelId = 'teams:19:source@thread.v2';
  await setUser('29:file-owner', { approved: true });
  await upsertChannelEntry(channelId, { slug: 'tool-source', name: 'tool-source', platform: 'msteams' });
  await saveChannelMeta('tool-source', { channelId, platform: 'msteams', access: 'approved' });
  const sent = [];
  registerTransport('msteams', { getConnector: () => ({ ready: () => true, shareFile: async args => {
    sent.push(args); return { messageId: 'file1' };
  } }) });
  try {
    await session(channelId, engine, async client => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(!names.some(name => name.startsWith('slack_')));
      assert.ok(names.includes('share_file'));
      assert.ok(names.includes('create_public_file_link'));
      assert.ok(GATEWAY_TOOL_NAMES.includes('share_file'));
      const result = await client.callTool({ name: 'share_file', arguments: { path: 'work/report.docx' } });
      assert.match(result.content[0].text, /Posted Open file/);
      assert.deepEqual(sent, [{ channelId, slug: 'tool-source', authorId: '29:file-owner', threadKey: '123456', relative: 'work/report.docx' }]);
      await setUser('29:file-owner', { approved: false });
      const refused = await client.callTool({ name: 'share_file', arguments: { path: 'work/report.docx' } });
      assert.match(refused.content[0].text, /no longer allowed/);
      assert.equal(sent.length, 1);
    });
    await setUser('29:file-owner', { approved: true });
    await upsertChannelEntry('gchat:spaces/source', { slug: 'tool-source', name: 'tool-source', platform: 'googlechat' });
    await saveChannelMeta('tool-source', { channelId: 'gchat:spaces/source', platform: 'googlechat', access: 'approved' });
    registerTransport('googlechat', { getConnector: () => ({ ready: () => true, shareFile: async args => { sent.push(args); } }) });
    await session('gchat:spaces/source', engine, async client => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(!names.some(name => name.startsWith('slack_')));
      assert.ok(names.includes('share_file'));
      assert.ok(names.includes('create_public_file_link'));
      const result = await client.callTool({ name: 'share_file', arguments: { path: 'work/report.docx' } });
      assert.match(result.content[0].text, /Google Chat.*No public link/);
      assert.deepEqual(sent.at(-1), { channelId: 'gchat:spaces/source', slug: 'tool-source', authorId: '29:file-owner', threadKey: '123456', relative: 'work/report.docx' });
    });
    await session('C_SOURCE', engine, async client => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('slack_share_file'));
      assert.ok(!names.includes('share_file'));
    });
  } finally { unregisterTransport('msteams'); unregisterTransport('googlechat'); }
});

for (const engine of ['claude', 'codex']) test(`${engine}: Teams public-link approval remains active without private links and creates a link only after the native Approve click`, async () => {
  const channelId = `teams:19:public-link-${engine}@thread.v2`;
  const root = path.join(process.env.CG_WORKSPACE_DIR, 'teams', 'tool-source');
  mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, 'report.docx'), 'fixture-file');
  await setUser('29:file-owner', { approved: true });
  await upsertChannelEntry(channelId, { name: 'tool-source', platform: 'msteams' });
  await saveChannelMeta('tool-source', { channelId, platform: 'msteams', workDir: root, access: 'approved' });
  saveSettings({ publicUrl: 'https://gateway.example.test', publicFileLinksEnabled: true, approvalLinks: 'always' });
  const cards = []; let posted;
  const displayed = new Promise(resolve => { posted = resolve; });
  registerTransport('msteams', { getConnector: () => ({ ready: () => true,
    postCard: async value => { cards.push(value); posted(); return { messageId: 'approval1', conversationId: channelId }; },
    updateCard: async () => {},
    openDm: async () => assert.fail('No private decision links'),
    post: async () => assert.fail('No fallback or DM posts'),
  }) });
  try {
    await session(channelId, engine, async client => {
      const pending = client.callTool({ name: 'create_public_file_link', arguments: { path: 'report.docx', purpose: 'share', minutes: 60 } });
      await displayed; await new Promise(resolve => setImmediate(resolve));
      const id = cards[0].card.actions[0].data.id;
      assert.ok(lookupApproval(id).entry, 'native card remains actionable after supplemental delivery');
      assert.equal(cards[0].conversationId, channelId);
      assert.equal(cards[0].threadKey, '123456');
      assert.equal(listPublicFileLinks(channelId).length, 0, 'the file is not public before a human click');
      const decision = await handlePlatformApproval({ id, decision: 'approve', conversationId: channelId,
        messageId: 'approval1', actorId: '29:file-owner' });
      assert.equal(decision.ok, true);
      const result = await pending;
      assert.match(result.content[0].text, /https:\/\/gateway\.example\.test\/f\//);
      assert.match(result.content[0].text, /live 1 hour/);
      assert.equal(listPublicFileLinks(channelId).length, 1);
    }, { daemon: createDirectDaemonIpc({ approval: body => requestApproval(null, body) }) });
  } finally { unregisterTransport('msteams'); }
});
