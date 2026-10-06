import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv, tempDir } from './helpers.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
ensureTestEnv();
const { renderCatalogPage, handleCatalogAction } = await import('../src/platforms/msteams/settings-catalog.js');
const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, patchChannelMeta, getUser, setUser } = await import('../src/config/store.js');
const { saveSettings } = await import('../src/config/settings.js');
const { patchOrgEnv, listOrgEnv } = await import('../src/config/scoped-env.js');
const { patchChannelEnv } = await import('../src/config/channel-env.js');
const { putSkillRevision, upsertTemplate } = await import('../src/gateway/skills/catalog.js');

const ui = {
  text: text => ({ type: 'TextBlock', text }), heading: text => ({ type: 'TextBlock', text }),
  input: (id, label, value) => ({ type: 'Input.Text', id, label, value }),
  choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, value, choices }),
  execute: (title, action, data = {}, associatedInputs) => ({ title, action, data, associatedInputs }),
  buttons: actions => ({ type: 'ActionSet', actions }),
};
let counter = 0;
async function context({ admin = false, fields = {} } = {}) {
  const channelId = `msteams:settings-catalog-${++counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `catalog-${counter}`, platform: 'msteams', type: 'channel', isDM: false });
  const meta = { ...defaultChannelMeta({ channelId, name: entry.name, platform: 'msteams', type: 'channel', isDM: false }), ...fields };
  await saveChannelMeta(entry.slug, meta);
  const ownerId = `msteams:catalog-user-${counter}`;
  await setUser(ownerId, { approved: true, isAdmin: admin });
  const ctx = { entry, meta, ownerId, channelId, userIsAdmin: admin, userIsApproved: true, state: {} };
  ctx.authorize = async () => { ctx.meta = await getChannelMeta(entry.slug); ctx.userIsAdmin = Boolean((await getUser(ownerId)).isAdmin); return ctx; };
  ctx.patch = async updater => { const fresh = await ctx.authorize(); ctx.meta = await patchChannelMeta(entry.slug, current => updater(current, fresh)); return ctx.meta; };
  return ctx;
}
const invoke = (ctx, action, data) => handleCatalogAction(action, data, ctx, ui);
const skill = (slug, options = {}) => putSkillRevision({ slug, files: [{ path: 'SKILL.md', content: `---\nname: ${slug}\ndescription: Catalog test\n---\nDo one thing.\n` }], ...options });

test('variable writes bind to server channel/person and cannot forge organization privileges', async () => {
  const ctx = await context();
  const other = await context();
  await invoke(ctx, 'settings.variable.save', { variableScope: 'personal', variableName: 'TEST_API_TOKEN', variableValue: 'personal-secret-fixture-long', ownerId: other.ownerId, channelId: other.channelId });
  assert.ok((await getUser(ctx.ownerId)).env.TEST_API_TOKEN);
  assert.equal((await getUser(other.ownerId)).env, undefined);
  await assert.rejects(invoke(ctx, 'settings.variable.save', { variableScope: 'organization', variableName: 'TEST_ORG_TOKEN', variableValue: 'org-secret-fixture-long', userIsAdmin: true }), /Only administrators/);
  await assert.rejects(invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'NODE_OPTIONS', variableValue: 'bad' }), /reserved|cannot/i);
  await assert.rejects(invoke(ctx, 'settings.variable.save', { variableScope: 'unknown', variableName: 'TEST_TOKEN', variableValue: 'bad' }), /scope/);
});

test('variable host rules validate, survive rotation and clear only by explicit selection', async () => {
  const ctx = await context();
  await invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'ROTATION_TOKEN', variableValue: 'first-long-secret-fixture', variableHostsMode: 'replace', variableHosts: 'api.example.com' });
  await invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'ROTATION_TOKEN', variableValue: 'second-long-secret-fixture', variableHostsMode: 'preserve' });
  assert.deepEqual((await getChannelMeta(ctx.entry.slug)).env.ROTATION_TOKEN.hosts, ['api.example.com']);
  await assert.rejects(invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'ROTATION_TOKEN', variableValue: 'bad-host-fixture-secret', variableHostsMode: 'replace', variableHosts: 'https://api.example.com/path' }), /host/i);
  assert.equal((await getChannelMeta(ctx.entry.slug)).env.ROTATION_TOKEN.value, 'second-long-secret-fixture');
  await invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'ROTATION_TOKEN', variableValue: 'third-long-secret-fixture', variableHostsMode: 'clear' });
  assert.equal((await getChannelMeta(ctx.entry.slug)).env.ROTATION_TOKEN.hosts, undefined);
  await invoke(ctx, 'settings.variable.remove', { variableScope: 'channel', name: 'ROTATION_TOKEN' });
  assert.equal((await getChannelMeta(ctx.entry.slug)).env.ROTATION_TOKEN, undefined);
});

test('organization edits recheck roles and do not use stale admin card data', async () => {
  const ctx = await context({ admin: true });
  await invoke(ctx, 'settings.variable.save', { variableScope: 'organization', variableName: 'ORG_CATALOG_TOKEN', variableValue: 'org-catalog-fixture-secret' });
  assert.ok(listOrgEnv().some(item => item.name === 'ORG_CATALOG_TOKEN'));
  await setUser(ctx.ownerId, { isAdmin: false });
  await assert.rejects(invoke(ctx, 'settings.variable.remove', { variableScope: 'organization', name: 'ORG_CATALOG_TOKEN' }), /Only administrators/);
  assert.ok(listOrgEnv().some(item => item.name === 'ORG_CATALOG_TOKEN'));
  patchOrgEnv({ remove: 'ORG_CATALOG_TOKEN' });
});

test('all variable scopes render masked and no stored value becomes a card field or action', async () => {
  const value = 'never-show-the-full-variable-secret';
  const ctx = await context({ fields: { env: patchChannelEnv({}, { set: { name: 'CARD_SECRET', value } }) } });
  await invoke(ctx, 'settings.variable.save', { variableScope: 'personal', variableName: 'PERSON_CARD_SECRET', variableValue: `${value}-personal` });
  patchOrgEnv({ set: { name: 'ORG_CARD_SECRET', value: `${value}-org` } });
  const card = await renderCatalogPage('secrets', ctx, ui);
  assert.ok(JSON.stringify(card).includes('CARD_SECRET'));
  assert.ok(JSON.stringify(card).includes('PERSON_CARD_SECRET'));
  assert.ok(JSON.stringify(card).includes('ORG_CARD_SECRET'));
  assert.ok(!JSON.stringify(card).includes(value));
  assert.equal(card.body.find(item => item.id === 'variableValue').value, '');
  assert.ok(!card.body.some(item => item.actions?.some(action => action.data.variableScope === 'organization')));
  patchOrgEnv({ remove: 'ORG_CARD_SECRET' });
});

test('connection rotation preserves blank tokens and validates Make URLs atomically', async () => {
  const ctx = await context({ fields: { composioToken: 'existing-composio-fixture', toolboxToken: 'existing-toolbox-fixture', makeToolboxUrl: 'https://eu1.make.com/mcp/server/catalog-fixture', makeToolboxKey: 'existing-make-fixture' } });
  await invoke(ctx, 'settings.connections.save', { composioToken: '', toolboxToken: '', composioTokenLabel: 'Shared account', makeToolboxUrl: ctx.meta.makeToolboxUrl, makeToolboxKey: '' });
  let stored = await getChannelMeta(ctx.entry.slug);
  assert.equal(stored.composioToken, 'existing-composio-fixture');
  assert.equal(stored.toolboxToken, 'existing-toolbox-fixture');
  assert.equal(stored.makeToolboxKey, 'existing-make-fixture');
  assert.equal(stored.composioTokenLabel, 'Shared account');
  await assert.rejects(invoke(ctx, 'settings.connections.save', { composioToken: 'new-composio-fixture', makeToolboxUrl: 'https://evil.example/mcp/server/id' }), /Make toolbox URL/);
  stored = await getChannelMeta(ctx.entry.slug);
  assert.equal(stored.composioToken, 'existing-composio-fixture');
  const card = await renderCatalogPage('mcp', ctx, ui);
  assert.ok(!JSON.stringify(card).includes('existing-composio-fixture'));
  for (const id of ['composioToken', 'toolboxToken', 'makeToolboxKey']) assert.equal(card.body.find(item => item.id === id).value, '');
  await invoke(ctx, 'settings.connections.fallback', { enabled: false });
  assert.equal((await getChannelMeta(ctx.entry.slug)).noDefaultTokens, true);
  await assert.rejects(invoke(ctx, 'settings.connections.remove', { connection: 'toString' }), /Unknown connection/);
  await invoke(ctx, 'settings.connections.remove', { connection: 'make' });
  stored = await getChannelMeta(ctx.entry.slug);
  assert.equal(stored.makeToolboxUrl, ''); assert.equal(stored.makeToolboxKey, '');
});

test('cloud mutations reject stale admins and inherited organization grants', async () => {
  const ctx = await context();
  await assert.rejects(invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'cloud-fixture', activate: true, userIsAdmin: true }), /Only administrators/);
  await setUser(ctx.ownerId, { isAdmin: true });
  saveSettings({ accessGrants: { allowedMcps: [{ name: 'cloud-fixture', match: 'cloud-fixture', namespace: 'cloud-fixture' }] } });
  await assert.rejects(invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'cloud-fixture', activate: false }), /inherited/);
  await assert.rejects(invoke(ctx, 'settings.cloud.toggle', { engine: 'unknown', key: 'cloud-fixture', activate: false }), /Invalid Cloud/);
  saveSettings({ accessGrants: {} });
});

test('skill catalogs paginate, hide personal/private skills, preserve inherited organization grants', async () => {
  const ctx = await context();
  for (let i = 0; i < 8; i++) skill(`catalog-public-${i}`);
  skill('catalog-personal', { visibility: 'personal', createdBy: ctx.ownerId });
  skill('catalog-undiscoverable');
  const { setSkillDiscoverable } = await import('../src/gateway/skills/catalog.js');
  setSkillDiscoverable('catalog-undiscoverable', false);
  saveSettings({ accessGrants: { skills: ['catalog-public-0'] } });
  const card = await renderCatalogPage('skills', ctx, ui);
  assert.ok(!JSON.stringify(card).includes('catalog-personal'));
  assert.ok(!JSON.stringify(card).includes('catalog-undiscoverable'));
  assert.ok(card.actions.some(action => action.title === 'Next'));
  assert.ok(!card.body.some(item => item.actions?.some(action => action.data.key === 'catalog-public-0')));
  await assert.rejects(invoke(ctx, 'settings.skills.toggle', { key: 'catalog-public-0', activate: false }), /inherited/);
  await assert.rejects(invoke(ctx, 'settings.skills.toggle', { key: 'catalog-personal', activate: true }), /no longer available/);
  await assert.rejects(invoke(ctx, 'settings.skills.toggle', { key: 'catalog-undiscoverable', activate: true }), /no longer available/);
  await invoke(ctx, 'settings.catalog.page', { page: 'skills', index: 1 });
  const page2 = await renderCatalogPage('skills', ctx, ui);
  assert.ok(page2.actions.some(action => action.title === 'Previous'));
  saveSettings({ accessGrants: {} });
});

test('template and skill mutations affect only current channel and retain unrelated metadata', async () => {
  const ctx = await context({ fields: { allowNetwork: false, instructions: 'untouched fixture' } });
  const other = await context();
  skill('catalog-template-skill');
  upsertTemplate({ slug: 'catalog-template', name: 'Catalog template', skills: ['catalog-template-skill'] });
  await invoke(ctx, 'settings.template', { skillTemplate: 'catalog-template', channelId: other.channelId, slug: other.entry.slug });
  let stored = await getChannelMeta(ctx.entry.slug);
  assert.equal(stored.skillTemplate, 'catalog-template');
  assert.equal((await getChannelMeta(other.entry.slug)).skillTemplate, '');
  await invoke(ctx, 'settings.skills.toggle', { key: 'catalog-template-skill', activate: false });
  assert.ok((await getChannelMeta(ctx.entry.slug)).skillsOff.includes('catalog-template-skill'));
  await ctx.authorize();
  await invoke(ctx, 'settings.skills.toggle', { key: 'catalog-template-skill', activate: true });
  stored = await getChannelMeta(ctx.entry.slug);
  assert.ok(stored.skills.includes('catalog-template-skill'));
  assert.ok(!stored.skillsOff.includes('catalog-template-skill'));
  assert.equal(stored.instructions, 'untouched fixture'); assert.equal(stored.allowNetwork, false);
  await assert.rejects(invoke(ctx, 'settings.template', { skillTemplate: 'does-not-exist' }), /no longer available/);
  await assert.rejects(invoke(ctx, 'settings.template', {}), /Choose a skill template/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).skillTemplate, 'catalog-template');
});

test('lost or changed authorization prevents writes and unknown actions stay unhandled', async () => {
  const ctx = await context();
  ctx.authorize = async () => { throw new Error('membership revoked'); };
  await assert.rejects(invoke(ctx, 'settings.variable.save', { variableScope: 'channel', variableName: 'SHOULD_NOT_EXIST', variableValue: 'never-written-secret' }), /membership revoked/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).env, undefined);
  assert.equal(await invoke(ctx, 'unknown', {}), false);
});

test('large variable and template inventories remain bounded with reachable pagination', async () => {
  let env = {};
  const hosts = Array.from({ length: 16 }, (_, i) => `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(55)}${i}.com`);
  for (let i = 0; i < 32; i++) env = patchChannelEnv(env, { set: { name: `LONG_VARIABLE_${i}`, value: 'long-stress-fixture-value', hosts }, actor: 'set-by'.repeat(100) });
  const ctx = await context({ fields: { env } });
  const variables = await renderCatalogPage('secrets', ctx, ui);
  assert.ok(Buffer.byteLength(JSON.stringify(variables)) < 16_000);
  assert.ok(variables.actions.some(action => action.title === 'Next'));
  for (let i = 0; i < 120; i++) upsertTemplate({ slug: `stress-template-${i}`, name: `Template ${i} ${'x'.repeat(1000)}`, skills: [] });
  const skills = await renderCatalogPage('skills', ctx, ui);
  assert.ok(Buffer.byteLength(JSON.stringify(skills)) < 16_000);
  assert.ok(skills.body.some(item => item.actions?.some(action => action.data.catalog === 'templates' && action.title === 'Next')));
  await invoke(ctx, 'settings.catalog.page', { page: 'skills', catalog: 'templates', index: 5 });
  assert.equal(ctx.state.templatePage, 5);
  assert.equal(ctx.state.skillPage, undefined);
  const picker = (await renderCatalogPage('skills', ctx, ui)).body.find(item => item.id === 'skillTemplate');
  assert.ok(picker.choices.length <= 22);
});

test('Cloud MCP activation uses live discovered selections, pages them, and rechecks role at write', async () => {
  const bin = tempDir('cg-teams-cloud-bin-');
  const output = Array.from({ length: 12 }, (_, i) => `catalog-server-${i}: https://mcp.example.com/${i} (HTTP) - Connected`).join('\n');
  await writeFile(path.join(bin, 'claude'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  const { invalidateEngineMcps } = await import('../src/gateway/mcp-discovery.js');
  invalidateEngineMcps('claude');
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    const ctx = await context({ admin: true });
    await invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'catalog-server-1', activate: true, selection: { name: 'forged-server' } });
    const selection = (await getChannelMeta(ctx.entry.slug)).allowedMcps[0];
    assert.equal(selection.name, 'catalog-server-1');
    assert.deepEqual(selection.match, { serverUrl: 'https://mcp.example.com/1' });
    assert.deepEqual(Object.keys(selection).sort(), ['match', 'name', 'namespace']);
    const card = await renderCatalogPage('mcp', ctx, ui);
    assert.ok(card.actions.some(action => action.title === 'Next'));
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 16_000);
    await invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'catalog-server-1', activate: false });
    assert.deepEqual((await getChannelMeta(ctx.entry.slug)).allowedMcps, []);
    await assert.rejects(invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'not-in-live-catalog', activate: true }), /no longer available/);
    const authorize = ctx.authorize;
    let calls = 0;
    ctx.authorize = async () => { if (++calls === 3) await setUser(ctx.ownerId, { isAdmin: false }); return authorize(); };
    await assert.rejects(invoke(ctx, 'settings.cloud.toggle', { engine: 'claude', key: 'catalog-server-2', activate: true }), /Only administrators/);
    assert.deepEqual((await getChannelMeta(ctx.entry.slug)).allowedMcps, []);
  } finally {
    process.env.PATH = originalPath;
    invalidateEngineMcps('claude');
  }
});
