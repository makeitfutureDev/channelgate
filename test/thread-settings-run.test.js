import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { ensureTestEnv } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.PATH = `${path.join(root, 'test', 'fixtures')}${path.delimiter}${process.env.PATH || ''}`;
process.env.SESSION_KEEPALIVE = '0';
const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, 'thread-settings-workspaces');
const { operatorClaudeConfigDir } = await import('../src/gateway/claude-login.js');
await mkdir(operatorClaudeConfigDir(), { recursive: true });
await writeFile(path.join(operatorClaudeConfigDir(), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-thread-test', expiresAt: Date.now() + 4 * 3600_000, refreshTokenExpiresAt: Date.now() + 20 * 86400_000 } }));

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import('../src/config/store.js');
const { saveSettings } = await import('../src/config/settings.js');
const { setThreadSettings } = await import('../src/gateway/thread-settings.js');
const { setThreadClean } = await import('../src/gateway/thread-engine.js');
const { putSkillRevision, tombstoneSkill, upsertTemplate, deleteTemplate } = await import('../src/gateway/skills/catalog.js');
const { runMessage, setRuntimeResolver } = await import('../src/gateway/run.js');
const { createFakeRuntimeBackend, fakeTarget } = await import('./runtime-fake.js');
const { BackgroundJobs } = await import('../src/gateway/background.js');
const { mintGatewayCapability, verifyGatewayCapability } = await import('../src/gateway/mcp-capability.js');
const { ctxFromClaims } = await import('../src/mcp/gateway-server.js');
const { register: registerBackgroundTools } = await import('../src/mcp/tools/background.js');
const { getDb } = await import('../src/db/index.js');
const { approvalActionKey } = await import('../src/gateway/approval-requests.js');

saveSettings({ memoryReviewEvery: 0, composioMode: 'personal', engineFallback: false, codexEnabled: true });
test.afterEach(() => setRuntimeResolver(null));

for (const engine of ['claude', 'codex']) test(`${engine} thread changes reach fresh/resumed turns while shared settings and sibling threads remain unchanged`, async () => {
  const channelId = `C_THREAD_SETTINGS_${engine}`;
  const authorId = 'U_THREAD_SETTINGS';
  await setUser(authorId, { approved: true, skills: [] });
  const entry = await upsertChannelEntry(channelId, { name: `thread-settings-${engine}`, type: 'channel', platform: 'slack' });
  const channelMeta = { channelId, name: entry.slug, type: 'channel', template: 'custom', engine, platform: 'slack', allowedMcps: [], skills: [] };
  await saveChannelMeta(entry.slug, channelMeta);
  const skillName = `thread-settings-${engine}-skill`;
  putSkillRevision({ slug: skillName, files: [{ path: 'SKILL.md', content: `---\nname: ${skillName}\ndescription: Thread skill test\n---\nThread-only instructions\n` }] });
  setThreadSettings(entry.slug, 'selected', 'skills', { skills: [skillName] });
  setThreadSettings(entry.slug, 'selected', 'secrets', { env: { THREAD_ONLY_VALUE: { provider: 'local', value: 'synthetic-thread-value' } } });
  const backend = createFakeRuntimeBackend();
  const resolved = [];
  setRuntimeResolver((slug, meta, options) => { resolved.push(meta); return fakeTarget(backend, slug, meta, options); });
  for (const text of ['first', 'resume']) {
    const result = await runMessage({ channelId, authorId, text, threadKey: 'selected', origin: 'slack_foreground', preferCold: true });
    assert.equal(result.engine, engine);
    assert.match(result.content, /stub.*reply/i);
    assert.equal(backend.calls.spawn.at(-1).env.THREAD_ONLY_VALUE, 'synthetic-thread-value');
    assert.ok(resolved.at(-1).skills.includes(skillName));
    if (engine === 'codex') {
      const args = JSON.stringify(backend.calls.spawn.at(-1).args);
      assert.ok(args.includes(skillName), 'thread skill reaches Codex explicit run catalog');
      assert.ok(args.includes('Current personal and thread skill grants'));
      assert.ok(args.includes('scope\\\":\\\"thread'));
    }
  }
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, []);
  const selectedTarget = fakeTarget(backend, entry.slug, channelMeta);
  await assert.rejects(access(path.join(selectedTarget.cwd, '.claude', 'skills', skillName)), { code: 'ENOENT' });
  const sibling = await runMessage({ channelId, authorId, text: 'sibling', threadKey: 'other', origin: 'slack_foreground', preferCold: true });
  assert.match(sibling.content, /stub.*reply/i);
  assert.equal(backend.calls.spawn.at(-1).env.THREAD_ONLY_VALUE, undefined);
  assert.ok(!resolved.at(-1).skills.includes(skillName));
  assert.equal(JSON.stringify(backend.calls.spawn.at(-1).args).includes(skillName), false);

  await runMessage({ channelId, authorId, text: 'background task', threadKey: 'selected::agent-synthetic', settingsSourceThreadKey: 'selected', origin: 'background_agent', preferCold: true });
  assert.equal(backend.calls.spawn.at(-1).env.THREAD_ONLY_VALUE, 'synthetic-thread-value');
  assert.equal(resolved.at(-1).threadSettingsKey, 'selected');
  assert.ok(resolved.at(-1).skills.includes(skillName));
});

test('background shell jobs inject only their authenticated source thread environment and preserve redacted logging', async () => {
  const channelId = 'C_THREAD_SETTINGS_JOB';
  const authorId = 'U_THREAD_SETTINGS_JOB';
  await setUser(authorId, { approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(channelId, { name: 'thread-settings-job', type: 'channel', platform: 'slack' });
  await saveChannelMeta(entry.slug, { channelId, name: entry.slug, type: 'channel', platform: 'slack', autoMode: true });
  setThreadSettings(entry.slug, 'launch', 'secrets', { env: { THREAD_JOB_VALUE: { provider: 'local', value: 'synthetic-thread-job-value' } } });
  const backend = createFakeRuntimeBackend();
  const jobs = new BackgroundJobs({ resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta), requestShellApproval: async () => ({ allow: true, decidedBy: authorId }) });
  const selected = await jobs.start({ channelId, authorId, threadKey: 'launch', command: 'true', label: 'thread job' });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(backend.calls.spawn.at(-1).env.THREAD_JOB_VALUE, 'synthetic-thread-job-value');
  assert.equal(JSON.stringify(backend.calls.spawn.at(-1).args).includes('synthetic-thread-job-value'), false);
  const sibling = await jobs.start({ channelId, authorId, threadKey: 'other', command: 'true', label: 'sibling job' });
  assert.equal(sibling.ok, true, sibling.error);
  assert.equal(backend.calls.spawn.at(-1).env.THREAD_JOB_VALUE, undefined);
  const nested = await jobs.start({ channelId, authorId, threadKey: 'launch::agent-one::agent-two', settingsSourceThreadKey: 'launch', command: 'true', label: 'nested job' });
  assert.equal(nested.ok, true, nested.error);
  assert.equal(backend.calls.spawn.at(-1).env.THREAD_JOB_VALUE, 'synthetic-thread-job-value');
  const persisted = JSON.parse(getDb().prepare('SELECT data FROM bg_jobs WHERE id = ?').get(nested.id).data);
  assert.equal(persisted.threadKey, 'launch::agent-one::agent-two', 'delivery identity stays separate');
  assert.equal(persisted.settingsSourceThreadKey, 'launch', 'source survives recovery');
  for (const job of jobs.jobs.values()) {
    job.releaseLive?.(); job.target?.runtime?.signal?.(job.child, 'SIGTERM');
  }
});

test('nested background tools inherit signed settings source and ignore caller-supplied source fields', async () => {
  const source = 'source-root';
  const identity = { secret: 'test-settings-source-secret', channelId: 'C_NESTED_SOURCE', slug: 'nested-source', authorId: 'U_NESTED_SOURCE', threadKey: 'source-root::agent-one', settingsSourceThreadKey: source, origin: 'background_agent', engine: 'claude' };
  const capability = mintGatewayCapability(identity);
  const checked = verifyGatewayCapability(capability, { secret: identity.secret });
  assert.equal(checked.ok, true);
  const calls = [];
  const ctx = ctxFromClaims(checked.claims, { daemon: { available: () => true, call: async (kind, body) => { calls.push({ kind, body }); return { ok: true, id: 'nested-job', label: 'job' }; } } });
  const handlers = new Map();
  registerBackgroundTools({ registerTool: (name, config, handler) => handlers.set(name, handler) }, ctx);
  await handlers.get('run_in_background')({ command: 'true', settingsSourceThreadKey: 'forged' });
  await handlers.get('run_agent_in_background')({ task: 'hello', settingsSourceThreadKey: 'forged' });
  assert.ok(calls.every(call => call.body.settingsSourceThreadKey === source));
  assert.ok(calls.every(call => call.body.threadKey === identity.threadKey));
  const oldCtx = ctxFromClaims({ ...checked.claims, settingsSourceThreadKey: undefined });
  assert.equal(oldCtx.settingsSourceThreadKey, identity.threadKey, 'older valid capabilities inherit their own thread');
  const [payload, signature] = capability.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.settingsSourceThreadKey = 'forged';
  assert.equal(verifyGatewayCapability(`${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`, { secret: identity.secret }).ok, false);
  assert.throws(() => mintGatewayCapability({ ...identity, settingsSourceThreadKey: { key: 'forged' } }), /Invalid thread settings source/);
  const action = { kind: 'background_shell', channelId: identity.channelId, authorId: identity.authorId, threadKey: identity.threadKey, command: 'true' };
  assert.notEqual(approvalActionKey({ ...action, settingsSourceThreadKey: source }), approvalActionKey({ ...action, settingsSourceThreadKey: 'other' }));
});

for (const engine of ['claude', 'codex']) test(`${engine} clean thread and per-run Lean bypass unavailable optional thread skills`, async () => {
  const channelId = `C_CLEAN_THREAD_SKILLS_${engine}`;
  const authorId = 'U_CLEAN_THREAD_SKILLS';
  await setUser(authorId, { approved: true, isAdmin: false, skills: [] });
  const entry = await upsertChannelEntry(channelId, { name: `clean-thread-skills-${engine}`, type: 'channel', platform: 'slack' });
  await saveChannelMeta(entry.slug, { channelId, name: entry.slug, type: 'channel', template: 'custom', engine, platform: 'slack', allowedMcps: [], skills: [] });
  const backend = createFakeRuntimeBackend();
  const resolved = [];
  setRuntimeResolver((slug, meta, options) => { resolved.push(meta); return fakeTarget(backend, slug, meta, options); });
  const deletedSkill = `deleted-thread-skill-${engine}`;
  putSkillRevision({ slug: deletedSkill, files: [{ path: 'SKILL.md', content: `---\nname: ${deletedSkill}\ndescription: Deleted optional skill fixture\n---\nOptional instructions\n` }] });
  tombstoneSkill(deletedSkill);
  const deletedTemplate = `deleted-thread-template-${engine}`;
  upsertTemplate({ slug: deletedTemplate, name: 'Deleted optional template fixture', skills: [] });
  deleteTemplate(deletedTemplate);
  for (const [key, settings] of Object.entries({ missing: { skills: ['skill-that-no-longer-exists'] }, deleted: { skills: [deletedSkill] }, template: { skillTemplate: deletedTemplate } })) {
    setThreadSettings(entry.slug, key, 'skills', settings);
    const input = { channelId, authorId, text: 'continue bare', threadKey: key, origin: 'slack_foreground', preferCold: true };
    await assert.rejects(runMessage(input), /no longer available/, 'ordinary turn still refuses an unavailable grant');
    const before = backend.calls.spawn.length;
    await setThreadClean(entry.slug, key, true);
    const threadClean = await runMessage(input);
    assert.match(threadClean.content, /stub.*reply/i);
    assert.equal(resolved.at(-1).cleanMode, true);
    assert.equal(resolved.at(-1).skills.includes('skill-that-no-longer-exists'), false);
    await setThreadClean(entry.slug, key, false);
    const runLean = await runMessage({ ...input, overrides: { mode: 'lean' } });
    assert.match(runLean.content, /stub.*reply/i);
    assert.equal(resolved.at(-1).cleanMode, true);
    assert.equal(backend.calls.spawn.length, before + 2);
    await assert.rejects(runMessage(input), /no longer available/, 'clean turns never erase the unavailable stored selection');
  }
});
