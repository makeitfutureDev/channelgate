import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsFileResolver } = await import('../src/platforms/msteams/files.js');
const { normalizeActivity } = await import('../src/platforms/msteams/activity.js');
const { validateTeamsFileDriveIds, saveSettings, resolveTeamsConfig, settingsForApi } = await import('../src/config/settings.js');
const driveId = 'b!fixture_drive';
const contentUrl = 'https://fixture.sharepoint.com/sites/Team/Documents/sample.txt';
const downloadUrl = 'https://fixture.sharepoint.com/download/file?opaque=fixture';
const item = { id: 'item1', name: 'sample.txt', parentReference: { driveId }, file: { mimeType: 'text/plain' }, size: 4, '@microsoft.graph.downloadUrl': downloadUrl };
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(over = {}) {
  const calls = []; let tokens = 0;
  const resolve = createTeamsFileResolver({ auth: { token: async () => { tokens += 1; return 'fixture-graph-token'; } }, allowedDriveIds: [driveId], fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/root?')) return json({ id: 'root', webUrl: 'https://fixture.sharepoint.com/sites/Team/Documents' });
    if (url.startsWith('https://graph.microsoft.com/')) return json({ ...item, ...over });
    return new Response('DATA');
  } });
  return { resolve, calls, tokens: () => tokens };
}

test('canonical file URL resolves only inside an allowed drive; bearer stays on Graph', async () => {
  const f = fixture(); const download = f.resolve({ contentUrl });
  assert.equal(f.calls.length, 0); assert.equal(f.tokens(), 0, 'resolution is lazy until authorized download');
  assert.equal(await (await download()).text(), 'DATA'); assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].url, /\/drives\/b!fixture_drive\/root\?/);
  assert.match(f.calls[1].url, /\/root:\/sample.txt\?/);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer fixture-graph-token');
  assert.equal(f.calls[2].options.headers, undefined);
  for (const call of f.calls) assert.equal(call.options.redirect, 'error');
});

test('direct drive/item descriptors skip URL lookup but recheck returned identity', async () => {
  const f = fixture(); assert.equal(await (await f.resolve({ driveId, itemId: 'item1' })()).text(), 'DATA'); assert.equal(f.calls.length, 2);
  const changed = fixture({ id: 'item2' }); await assert.rejects(changed.resolve({ driveId, itemId: 'item1' })(), /identity/); assert.equal(changed.calls.length, 1);
});

test('invalid URLs, descriptors and unlisted drives never fetch or request credentials', () => {
  const f = fixture();
  for (const value of [{ contentUrl: 'http://fixture.sharepoint.com/file' }, { contentUrl: 'https://fixture.sharepoint.com.evil.test/file' }, { contentUrl: 'https://user:pass@fixture.sharepoint.com/file' }, { contentUrl: 'https://localhost/file' }, { contentUrl, arbitrary: true }, { driveId: 'other', itemId: 'item1' }, { driveId, itemId: '../item' }, { contentUrl, driveId, itemId: 'item1' }, null]) assert.equal(f.resolve(value), null);
  assert.equal(f.calls.length, 0); assert.equal(f.tokens(), 0);
});

test('drive mismatch or hostile download host fails before any bytes request', async () => {
  for (const fields of [{ parentReference: { driveId: 'other' } }, { '@microsoft.graph.downloadUrl': 'https://evil.test/file' }, { '@microsoft.graph.downloadUrl': 'https://fixture.sharepoint.com:444/file' }, { file: null }]) {
    const f = fixture(fields); await assert.rejects(f.resolve({ contentUrl })()); assert.equal(f.calls.length, 2);
  }
});

test('shortlinks and paths outside the allowed root never ask Graph shares or download content', async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ contentUrl: 'https://fixture.sharepoint.com/:w:/s/SomeShortLink' })(), /canonical/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls.some((call) => call.url.includes('/shares/')), false);
});

test('download stream enforces cap even when content length is absent', async () => {
  const resolve = createTeamsFileResolver({ auth: { token: async () => 'fixture' }, allowedDriveIds: [driveId], maxBytes: 3, fetchImpl: async (url) => url.startsWith('https://graph.microsoft.com') ? json({ ...item, size: 2 }) : new Response('TOO BIG') });
  const response = await resolve({ driveId, itemId: 'item1' })(); await assert.rejects(response.text(), /attachment limit/);
});

test('reference normalization preserves lazy resolver and original personal preauthenticated path', async () => {
  const f = fixture(); const base = { type: 'message', id: 'm', conversation: { id: '19:files', conversationType: 'groupchat' }, from: { id: '29:author' } };
  const message = normalizeActivity({ ...base, attachments: [{ contentType: 'reference', contentUrl, name: 'sample.txt' }] }, { resolveFile: f.resolve });
  assert.equal(f.calls.length, 0); assert.equal(await (await message.attachments[0].download()).text(), 'DATA');
  const personal = normalizeActivity({ ...base, attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', content: { downloadUrl, fileType: 'txt' }, name: 'sample.txt' }] }, { resolveFile: () => assert.fail('personal path must stay independent'), fetchImpl: async () => new Response('DIRECT') });
  assert.equal(await (await personal.attachments[0].download()).text(), 'DIRECT');
});

test('drive settings are bounded, explicit and non-secret; malformed stored policy fails closed', async () => {
  assert.deepEqual(validateTeamsFileDriveIds([driveId, driveId]), [driveId]);
  for (const invalid of ['drive', ['../drive'], Array(33).fill(driveId), [1], null]) assert.throws(() => validateTeamsFileDriveIds(invalid));
  await saveSettings({ teamsFilesEnabled: true, teamsFileDriveIds: [driveId] });
  assert.equal(resolveTeamsConfig().filesEnabled, true); assert.deepEqual(settingsForApi().teams.fileDriveIds, [driveId]);
  await saveSettings({ teamsFilesEnabled: 'true', teamsFileDriveIds: ['../drive'] });
  assert.equal(resolveTeamsConfig().filesEnabled, false); assert.deepEqual(resolveTeamsConfig().fileDriveIds, []);
  await saveSettings({ teamsFilesEnabled: false, teamsFileDriveIds: [] });
});

test('admin file settings reject nonboolean opt-in and malformed drive IDs atomically', async (t) => {
  const { default: express } = await import('express');
  const { createAdminRouter } = await import('../src/web/routes/admin.js');
  const app = express(); app.use(express.json()); app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => server.close());
  const patch = (body) => fetch(`http://127.0.0.1:${server.address().port}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const value of ['true', 1, null, {}]) assert.equal((await patch({ teamsFilesEnabled: value })).status, 400);
  assert.equal((await patch({ teamsFilesEnabled: true, teamsFileDriveIds: ['../bad'] })).status, 400); assert.equal(resolveTeamsConfig().filesEnabled, false);
  assert.equal((await patch({ teamsFilesEnabled: true, teamsFileDriveIds: [driveId] })).status, 200); assert.equal(resolveTeamsConfig().filesEnabled, true);
  await patch({ teamsFilesEnabled: false, teamsFileDriveIds: [] });
});

test('unapproved Teams user cannot cause Graph file metadata or token access', async () => {
  const { createIngest } = await import('../src/platforms/ingest.js');
  const f = fixture();
  const message = normalizeActivity({ type: 'message', id: 'denied', conversation: { id: '19:file-denied', conversationType: 'personal' }, from: { id: '29:file-unapproved' }, attachments: [{ contentType: 'reference', contentUrl, name: 'sample.txt' }] }, { resolveFile: f.resolve });
  const ingest = createIngest({ connector: { platform: 'msteams', post: async () => ({ messageId: 'denied-reply' }) }, run: async () => assert.fail('unapproved run'), log: { info() {} } });
  assert.equal((await ingest(message)).skipped, 'unauthorized'); assert.equal(f.calls.length, 0); assert.equal(f.tokens(), 0);
});
