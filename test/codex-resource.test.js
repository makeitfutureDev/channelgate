import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const fixtureBin = fileURLToPath(new URL('./fixtures', import.meta.url));
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`;
const { runCodex, isCodexResourceFailure } = await import('../src/engines/codex.js');
const { createFakeRuntimeBackend, fakeTarget } = await import('./runtime-fake.js');
const { runFailureDiagnostics } = await import('../src/util/process-outcome.js');
const diagnostic = 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"Failed to create unified exec process: Resource temporarily unavailable (os error 11)\\")" }';

test('resource classification requires Codex router process-creation evidence', () => {
  assert.equal(isCodexResourceFailure(diagnostic), true);
  for (const text of ['Resource temporarily unavailable', 'connection: EAGAIN', diagnostic.replace('codex_core::tools::router:', 'tool output:'), 'ERROR codex_core::tools::router: connection Resource temporarily unavailable']) assert.equal(isCodexResourceFailure(text), false);
});
for (const suffix of ['HANG', 'AFTER_TOOL', 'EXIT', 'NO_NEWLINE']) {
  test(`resource ${suffix}: fails before silence budget, keeps partial usage and prevents replay`, async () => {
    const backend = createFakeRuntimeBackend();
    let inspected = false;
    backend.inspectResources = async () => {
      inspected = true;
      return { processes: 1020, threads: 1024, cgroup: { current: '1024', max: '1024', eventsMax: '3' }, secret: 'never-log-me' };
    };
    const target = fakeTarget(backend, `resource-${suffix}`);
    const start = Date.now();
    await assert.rejects(runCodex({ cwd: fixtureBin, prompt: `CODEX_STUB_RESOURCE_${suffix}`, isNewSession: true, target, artifactDir: target.artifactDir, resourceRecoveryMs: 100, timeoutMs: 60_000 }), (err) => {
      assert.equal(err.details.errorCode, 'ENGINE_RESOURCE_EXHAUSTED');
      assert.equal(err.details.replaySafe, false);
      assert.notEqual(err.details.providerError, true);
      assert.ok(err.details.result, 'partial usage/result remains attached');
      if (suffix !== 'EXIT') assert.equal(err.details.result.usage.input_tokens, 12);
      assert.match(err.message, /runtime resources/);
      if (suffix === 'AFTER_TOOL') assert.ok(err.details.toolUseCount > 0);
      const logged = runFailureDiagnostics(err);
      assert.equal(logged.resourceSnapshot.cgroup.max, '1024');
      assert.equal(logged.resourceSnapshot.secret, undefined);
      return true;
    });
    assert.ok(inspected);
    assert.ok(Date.now() - start < 10_000, 'does not wait for watchdog');
  });
}
for (const suffix of ['RECOVER', 'REORDER']) test(`successful command execution clears the resource deadline (${suffix})`, async () => {
  const backend = createFakeRuntimeBackend();
  const target = fakeTarget(backend, 'resource-recovered');
  const result = await runCodex({ cwd: fixtureBin, prompt: `CODEX_STUB_RESOURCE_${suffix}`, isNewSession: true, target, artifactDir: target.artifactDir, resourceRecoveryMs: 100, timeoutMs: 60_000 });
  assert.equal(result.content, 'Recovered successfully');
  assert.equal(backend.calls.signal.length, 0);
});
for (const probe of ['missing', 'rejecting', 'hanging']) {
  test(`${probe} resource inspector does not delay or hide the resource error`, async () => {
    const backend = createFakeRuntimeBackend();
    if (probe === 'rejecting') backend.inspectResources = async () => { throw new Error('probe failed'); };
    if (probe === 'hanging') backend.inspectResources = () => new Promise(() => {});
    const target = fakeTarget(backend, `resource-${probe}`);
    await assert.rejects(runCodex({ cwd: fixtureBin, prompt: 'CODEX_STUB_RESOURCE_HANG', isNewSession: true, target, artifactDir: target.artifactDir, resourceRecoveryMs: 50, timeoutMs: 60_000 }), (err) => {
      assert.equal(err.details.errorCode, 'ENGINE_RESOURCE_EXHAUSTED');
      assert.deepEqual(err.details.resourceSnapshot, { unavailable: true });
      return true;
    });
  });
}


test('external cancellation during resource recovery remains an explicit stop', async () => {
  const backend = createFakeRuntimeBackend();
  const target = fakeTarget(backend, 'resource-cancelled');
  const controller = new AbortController();
  await assert.rejects(runCodex({ cwd: fixtureBin, prompt: 'CODEX_STUB_RESOURCE_HANG', isNewSession: true, target, artifactDir: target.artifactDir, resourceRecoveryMs: 500, timeoutMs: 60_000, signal: controller.signal,
    onEvent: (event) => { if (event.kind === 'engine_note' && /Resource temporarily unavailable/.test(event.text)) controller.abort(); },
  }), (err) => {
    assert.equal(err.name, 'AbortError');
    assert.notEqual(err.details.errorCode, 'ENGINE_RESOURCE_EXHAUSTED');
    return true;
  });
});
