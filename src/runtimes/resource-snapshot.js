// Fixed, read-only runtime facts. Never read argv, environments, command names or credentials.
// Self-contained so the container backend can execute these exact bytes without an image rebuild.
export async function collectResourceSnapshot({ pid = 'self', runId = '', procDir = '/proc', cgroupDir = '/sys/fs/cgroup' } = {}) {
  const { open, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const read = async (file) => {
    let handle;
    try {
      handle = await open(file, 'r');
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch { return ''; }
    finally { await handle?.close().catch(() => {}); }
  };
  if (runId && /^[a-zA-Z0-9_-]+$/.test(runId)) {
    const recorded = (await read(`/run/cg/${runId}.pid`)).trim();
    if (/^\d+$/.test(recorded)) pid = recorded;
  }
  if (!/^(self|\d+)$/.test(String(pid))) pid = 'self';
  const value = (text) => /^(\d+|max|unlimited)$/.test(text.trim()) ? text.trim() : null;
  const limits = await read(join(procDir, String(pid), 'limits'));
  const maxProcesses = /^Max processes\s+(\S+)\s+(\S+)/m.exec(limits);
  const cgroups = await read(join(procDir, String(pid), 'cgroup'));
  const memberships = cgroups.split('\n');
  const membership = memberships.find((line) => /^\d+:[^:]*\bpids\b[^:]*:/.test(line)) || memberships.find((line) => line.startsWith('0::'));
  let cgroup = null;
  if (membership) {
    const [, controllers, location] = membership.split(':');
    // A cgroup namespace may hide its ancestors. Never claim a host/global root is this run's cap.
    if (location?.startsWith('/') && !location.split('/').includes('..')) {
      const dir = join(cgroupDir, controllers ? 'pids' : '', location);
      cgroup = {
        leafOnly: true, // ancestor limits may apply, including ancestors hidden by the namespace
        current: value(await read(join(dir, 'pids.current'))),
        max: value(await read(join(dir, 'pids.max'))),
        eventsMax: value((/^max\s+(\d+)$/m.exec(await read(join(dir, 'pids.events'))) || [])[1] || ''),
      };
    }
  }
  let processes = null, threads = null, truncated = false;
  try {
    const entries = (await readdir(procDir)).filter((entry) => /^\d+$/.test(entry));
    processes = entries.length;
    threads = 0;
    truncated = entries.length > 4096;
    // Bounded concurrency and work even on an overloaded host. Vanished/unreadable entries make
    // thread totals incomplete rather than silently appearing as zero.
    for (let start = 0; start < Math.min(entries.length, 4096); start += 32) {
      const counts = await Promise.all(entries.slice(start, Math.min(start + 32, 4096)).map(async (entry) => {
        const match = /^Threads:\s+(\d+)$/m.exec(await read(join(procDir, entry, 'status')));
        return match ? Number(match[1]) : null;
      }));
      if (counts.includes(null)) truncated = true;
      threads += counts.reduce((sum, count) => sum + (count || 0), 0);
    }
  } catch { /* procfs unavailable */ }
  return { processes, threads, truncated, maxProcessesSoft: value(maxProcesses?.[1] || ''), maxProcessesHard: value(maxProcesses?.[2] || ''), cgroup };
}

// Fixed key allowlist for both error details and durable event logs, including optional backends.
export function resourceSnapshotFacts(snapshot) {
  const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const limit = (v) => typeof v === 'string' && /^(\d{1,20}|max|unlimited)$/.test(v) ? v : null;
  if (!snapshot || typeof snapshot !== 'object' || snapshot.unavailable === true) return { unavailable: true };
  return {
    processes: count(snapshot.processes), threads: count(snapshot.threads), truncated: snapshot.truncated === true,
    maxProcessesSoft: limit(snapshot.maxProcessesSoft), maxProcessesHard: limit(snapshot.maxProcessesHard),
    cgroup: snapshot.cgroup ? { leafOnly: true, current: limit(snapshot.cgroup.current), max: limit(snapshot.cgroup.max), eventsMax: limit(snapshot.cgroup.eventsMax) } : null,
  };
}
