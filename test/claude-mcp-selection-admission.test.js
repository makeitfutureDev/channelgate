import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
const scratch = ensureTestEnv();
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-mcp-admission');
await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const secret = 'fixture-host-credential';
const defs = { healthy: { command: 'node', args: ['echo.mjs'] }, credentialed: { command: 'node', env: { TOKEN: secret } } };
await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: defs }));
const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import('../src/config/store.js');
const { createAdminRouter } = await import('../src/web/routes/admin.js');
const pick = name => ({ name, namespace: `mcp__${name}`, match: { serverName: name } });
const app = express(); app.use(express.json()); app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

test('admin selection refuses missing and credentialed Claude definitions, admits healthy definitions, and retains unrelated stored picks', async () => {
  const id = 'C_CLAUDE_ADMISSION', entry = await upsertChannelEntry(id, { name: 'claude-admission', type: 'channel' });
  await saveChannelMeta(entry.slug, { channelId: id, name: entry.name, type: 'channel', template: 'custom', allowedMcps: [] });
  const put = selections => fetch(`${base}/channels/${id}/meta`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedMcps: selections }) });
  for (const name of ['missing', 'credentialed']) {
    const response = await put([pick(name)]);
    assert.equal(response.status, 400, name);
    const error = (await response.json()).error;
    assert.match(error, /not defined|host credentials/);
    assert.equal(error.includes(secret), false);
    assert.deepEqual((await getChannelMeta(entry.slug)).allowedMcps, []);
  }
  assert.equal((await put([pick('healthy')])).status, 200);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedMcps, [pick('healthy')]);
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), allowedMcps: [pick('credentialed')] });
  assert.equal((await put([pick('credentialed')])).status, 200, 'an unchanged legacy pick remains subject to run-time drop');
});


test('Claude discovery checks fresh transport definitions and never returns rejected CLI credential text', async () => {
  const { catalogFromClaudeList, persistedSelectionForEngine } = await import('../src/gateway/mcp-discovery.js');
  const catalog = await catalogFromClaudeList([
    'healthy: node echo.mjs - ✔ Connected',
    `credentialed: node --token ${secret} - ✔ Connected`,
    `missing: https://example.test/mcp?token=${secret} - ✔ Connected`,
  ].join('\n'));
  assert.equal(catalog.find(entry => entry.name === 'healthy').selectable, true);
  assert.deepEqual(persistedSelectionForEngine('claude', catalog.find(entry => entry.name === 'healthy')), pick('healthy'));
  for (const name of ['credentialed', 'missing']) {
    const entry = catalog.find(entry => entry.name === name);
    assert.equal(entry.connected, true, 'CLI connectivity alone does not prove admission');
    assert.equal(entry.selectable, false);
    assert.equal(persistedSelectionForEngine('claude', entry), null);
    assert.equal(entry.match, undefined);
    assert.equal(entry.target, undefined);
    assert.equal(entry.definition, undefined);
  }
  assert.equal(JSON.stringify(catalog).includes(secret), false);
});

test('selection rechecks a healthy cached definition after the operator makes it credential-bearing', async () => {
  const { assertNewMcpSelections } = await import('../src/gateway/mcp-selection.js');
  await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { healthy: { ...defs.healthy, headers: { Authorization: secret } } } }));
  try {
    await assert.rejects(assertNewMcpSelections('claude', [pick('healthy')]), /host credentials/);
    await assert.doesNotReject(assertNewMcpSelections('claude', [pick('healthy')], [pick('healthy')]));
    const { resolveClaudeMcpConfig } = await import('../src/engines/claude-mcp.js');
    const result = await resolveClaudeMcpConfig([pick('healthy')]);
    assert.deepEqual(result.servers, {});
    assert.match(result.rejected[0].reason, /host credentials/);
  } finally {
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: defs }));
  }
});

test('missing Claude definitions cannot be newly granted through any admin scope', async () => {
  const { saveSettings } = await import('../src/config/settings.js');
  saveSettings({ accessGrants: { allowedMcps: [] } });
  const id = 'D_CLAUDE_ADMISSION', entry = await upsertChannelEntry(id, { name: 'claude-admission-dm', type: 'im', isDM: true });
  await saveChannelMeta(entry.slug, { channelId: id, name: entry.name, type: 'im', isDM: true, template: 'custom', allowedMcps: [] });
  const cases = [
    [`/dms/${id}`, { allowedMcps: [pick('missing')] }],
    ['/settings', { accessGrants: { allowedMcps: [pick('missing')] } }],
    ['/settings', { channelTemplate: { allowedMcps: [pick('missing')] } }],
    ['/settings', { dmTemplates: { user: { allowedMcps: [pick('missing')] } } }],
    ['/users/U_MCP_ADMISSION', { accessGrants: { allowedMcps: [pick('missing')] } }],
  ];
  for (const [url, body] of cases) {
    const response = await fetch(`${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, url);
    assert.match((await response.json()).error, /not defined/);
  }
});
