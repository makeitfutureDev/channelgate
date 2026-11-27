import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureTestEnv, tempDir } from './helpers.js';
ensureTestEnv();
const { collectResourceSnapshot, resourceSnapshotFacts } = await import('../src/runtimes/resource-snapshot.js');
const { createContainerState } = await import('../src/runtimes/container/state.js');
const put = async (dir, file, content) => { const dest = path.join(dir, file); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, content); };

test('snapshot reads target limits and cgroup membership, counts threads, excludes names and secrets', async () => {
  const procDir = tempDir('resources-proc-');
  const cgroupDir = tempDir('resources-cgroup-');
  await put(procDir, '12/limits', 'Max processes             1000                 unlimited            processes\n');
  await put(procDir, '12/cgroup', '0::/user.slice/test.scope\n');
  await put(procDir, '12/status', 'Name: PRIVATE-COMMAND\nThreads:\t4\n');
  await put(procDir, '34/status', 'Threads:\t5\n');
  await put(cgroupDir, 'user.slice/test.scope/pids.current', '9\n');
  await put(cgroupDir, 'user.slice/test.scope/pids.max', '10\n');
  await put(cgroupDir, 'user.slice/test.scope/pids.events', 'max 3\n');
  const result = await collectResourceSnapshot({ pid: 12, procDir, cgroupDir });
  assert.deepEqual(result, { processes: 2, threads: 9, truncated: false, maxProcessesSoft: '1000', maxProcessesHard: 'unlimited', cgroup: { leafOnly: true, current: '9', max: '10', eventsMax: '3' } });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('unreadable processes and hidden cgroup membership remain incomplete, never use global root caps', async () => {
  const procDir = tempDir('resources-proc-');
  const cgroupDir = tempDir('resources-cgroup-');
  await put(procDir, '12/cgroup', '0::/../../hidden.scope\n');
  await put(cgroupDir, 'pids.max', '999\n');
  const result = await collectResourceSnapshot({ pid: 12, procDir, cgroupDir });
  assert.equal(result.truncated, true);
  assert.equal(result.maxProcessesSoft, null);
  assert.equal(result.cgroup, null);
});

test('missing procfs is unavailable and log facts reject arbitrary backend payloads', async () => {
  const result = await collectResourceSnapshot({ procDir: '/does-not-exist', cgroupDir: '/does-not-exist' });
  assert.equal(result.processes, null);
  assert.equal(result.threads, null);
  assert.deepEqual(resourceSnapshotFacts({ unavailable: true, secret: 'hidden' }), { unavailable: true });
  const filtered = resourceSnapshotFacts({ processes: -1, threads: 'secret', maxProcessesSoft: 'secret', cgroup: { current: '1', max: 'secret', secret: 'hidden' }, secret: 'hidden' });
  assert.equal(filtered.processes, null);
  assert.equal(filtered.threads, null);
  assert.equal(JSON.stringify(filtered).includes('secret'), false);
});

test('container probe executes the self-contained reducer without lifecycle changes or retry', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = { runExec: async (_target, args, opts) => {
    assert.equal(args[0], 'fixture');
    assert.equal(opts.retry, false);
    assert.equal(opts.timeoutMs, 2000);
    const { stdout } = await promisify(execFile)(process.execPath, args.slice(2));
    return { code: 0, stdout };
  } };
  const state = createContainerState({ exec, lifecycle: { ensureUp() { assert.fail('no lifecycle changes'); } } });
  const result = await state.inspectResources({ container: { name: 'fixture' } });
  assert.ok(result.processes > 0);
  const failed = createContainerState({ exec: { runExec: async () => ({ code: 1, stderr: 'private details' }) } });
  await assert.rejects(failed.inspectResources({ container: { name: 'fixture' } }), { message: 'runtime resource inspection unavailable' });
});


test('hybrid cgroups prefer the explicit v1 pids controller over unified membership', async () => {
  const procDir = tempDir('resources-hybrid-');
  const cgroupDir = tempDir('resources-hybrid-cgroup-');
  await put(procDir, '12/cgroup', '0::/unified\n4:pids:/limited\n');
  await put(cgroupDir, 'pids/limited/pids.max', '64\n');
  await put(cgroupDir, 'unified/pids.max', 'max\n');
  const result = await collectResourceSnapshot({ pid: 12, procDir, cgroupDir });
  assert.equal(result.cgroup.max, '64');
  assert.equal(result.cgroup.leafOnly, true, 'does not claim effective ancestor limits');
});
