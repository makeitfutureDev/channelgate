// On-demand Google Drive sync (gateway/drivesync.js): the per-channel "Sync now" (admin UI + the
// sync_channel_drive agent tool through daemon IPC) and Settings → "Sync all now". Drives the real
// orchestration against a fake rclone so the gating, the per-channel in-flight guard, the recorded
// outcome and the first-run --resync behave exactly as the scheduled sweep does.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { syncChannelNow, syncAllNow, driveSyncStatus, driveSyncStatusAll, handleDriveSyncIpc, resolveSyncConfig, __setDriveSyncLauncher, __setDriveSyncContainerProbe, __setDriveSyncNotifier, HOST_LAUNCHER, NEEDS_RESYNC_SUMMARY } = await import("../src/gateway/drivesync.js");
// The fake rclone runs on the host; production launches the pass in a confined container
// (drivesync.test.js covers that argv).
__setDriveSyncLauncher(HOST_LAUNCHER);
// No container runtime is consulted: a test lists the "running" pass containers it wants seen.
const probe = { running: [], removed: [], list: async () => probe.running.slice(), remove: async (names) => { probe.removed.push(...names); probe.running = []; } };
__setDriveSyncContainerProbe(probe);
// Admin notices are recorded, never sent.
const notices = [];
__setDriveSyncNotifier(async (text, info) => { notices.push({ text, ...info }); return 1; });
const { saveSettings } = await import("../src/config/settings.js");
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");

const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "p",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  client_email: "bot@p.iam.gserviceaccount.com",
});

// A fake rclone: `version` succeeds; a pass waits while `block` exists, records its argv in
// `calls`, and fails with a diagnostic while `fail` exists. A successful pass leaves a one-file
// listing in its --workdir, as a real bisync over a non-empty folder does (an EMPTY listing forces
// the next pass to --resync, drivesync.test.js). Paths are baked in because the child env is the
// gateway's curated one, not this test's.
const fake = tempDir("cg-fake-rclone-");
const bin = path.join(fake, "rclone");
const calls = path.join(fake, "calls");
const block = path.join(fake, "block");
const fail = path.join(fake, "fail");
const wedged = path.join(fake, "wedged"); // while it exists, every non-resync pass aborts like a wedged bisync
writeFileSync(bin, `#!/bin/sh
[ "$1" = version ] && exit 0
while [ -f "${block}" ]; do sleep 0.05; done
echo "$*" >> "${calls}"
if [ -f "${wedged}" ] && ! echo "$*" | grep -q -- "--resync"; then echo "ERROR : Bisync critical error: cannot find prior Path1 or Path2 listings, likely due to critical error on prior run" >&2; echo "ERROR : Bisync aborted. Must run --resync to recover." >&2; exit 7; fi
if [ -f "${fail}" ]; then echo "ERROR : Failed to bisync: googleapi: Error 403: insufficient permissions" >&2; exit 2; fi
wd=""; prev=""; for a in "$@"; do [ "$prev" = "--workdir" ] && wd="$a"; prev="$a"; done
if [ -n "$wd" ]; then for side in path1 path2; do printf '# bisync listing v1\\n-        2 - - 2026-09-25T00:00:00Z "f.txt"\\n' > "$wd/fake.$side.lst"; done; fi
exit 0
`);
chmodSync(bin, 0o755);

const readCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function addChannel(channelId, name, syncDriveFolder) {
  const entry = await upsertChannelEntry(channelId, { name, type: "C", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name, type: "C", isDM: false }), syncDriveFolder });
  return entry.slug;
}

test("manual sync obeys the global switch, the key and rclone — same reasons as the schedule", async () => {
  await saveSettings({ driveSyncEnabled: false, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const slug = await addChannel("C_DS_OFF", "ds-off", "https://drive.google.com/drive/folders/FID_OFF_123");
  const off = await syncChannelNow(slug);
  assert.equal(off.ok, false);
  assert.equal(off.started, false);
  assert.match(off.error, /turned off/);
  assert.match((await syncAllNow()).error, /turned off/);

  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: "", driveSyncKeyFile: "", driveSyncRclonePath: bin });
  assert.match(resolveSyncConfig().error, /service-account key/);

  await saveSettings({ driveSyncKeyJson: SA_JSON, driveSyncRclonePath: path.join(fake, "missing-rclone") });
  assert.match(resolveSyncConfig().error, /rclone not found/);
  assert.deepEqual(readCalls(), [], "nothing ran while the feature was not armed");
});

test("Sync now runs one channel's pass, records the outcome, and resyncs only the first time", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const unlinked = await addChannel("C_DS_NONE", "ds-none", "");
  assert.match((await syncChannelNow(unlinked)).error, /No Google Drive folder/);
  assert.match((await syncChannelNow("no-such-slug")).error, /Unknown channel/);

  const slug = await addChannel("C_DS_ONE", "ds-one", "https://drive.google.com/drive/folders/FID_ONE_123");
  rmSync(calls, { force: true });
  const first = await syncChannelNow(slug, { waitMs: 5000 });
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.equal(first.done, true);
  assert.equal(first.status.running, false);
  assert.equal(first.status.last.ok, true);
  assert.equal(first.status.last.trigger, "manual");
  assert.equal(first.status.last.firstRun, true);
  const second = await syncChannelNow(slug, { waitMs: 5000, trigger: "admin-ui" });
  assert.equal(second.status.last.firstRun, false);
  assert.equal(second.status.last.trigger, "admin-ui");
  const argv = readCalls();
  assert.equal(argv.length, 2, "exactly this channel's two passes ran (the unlinked channel never did)");
  assert.match(argv[0], /^bisync .*--drive-root-folder-id FID_ONE_123/);
  assert.match(argv[0], /--resync/);
  assert.doesNotMatch(argv[1], /--resync/);
});

test("a running pass is never doubled, and a failure reports a concise reason", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const slug = await addChannel("C_DS_BUSY", "ds-busy", "https://drive.google.com/drive/folders/FID_BUSY_123");
  rmSync(calls, { force: true });
  writeFileSync(block, "");
  writeFileSync(fail, "");
  try {
    const started = await syncChannelNow(slug);
    assert.equal(started.started, true);
    assert.equal(started.done, false);
    assert.equal(driveSyncStatus(slug).running, true);
    const again = await syncChannelNow(slug);
    assert.equal(again.ok, true);
    assert.equal(again.busy, true);
    assert.equal(again.started, false);
  } finally {
    rmSync(block, { force: true });
  }
  await until(() => !driveSyncStatus(slug).running);
  rmSync(fail, { force: true });
  const status = driveSyncStatus(slug);
  assert.equal(status.last.ok, false);
  assert.match(status.last.summary, /403/);
  assert.equal(status.last.tail, undefined, "the raw rclone tail never leaves the daemon");
  assert.equal(readCalls().length, 1, "the busy request did not start a second pass");
});

test("the agent tool's daemon IPC is bounded and needs the capability-bound channel", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const slug = await addChannel("C_DS_IPC", "ds-ipc", "https://drive.google.com/drive/folders/FID_IPC_123");
  assert.deepEqual(await handleDriveSyncIpc({ action: "sync" }), { ok: false, error: "missing channel" });
  assert.match((await handleDriveSyncIpc({ action: "rm", slug })).error, /unknown drive sync action/);
  const synced = await handleDriveSyncIpc({ action: "sync", slug, waitMs: 5000 });
  assert.equal(synced.done, true);
  assert.equal(synced.status.last.trigger, "agent");
  const status = await handleDriveSyncIpc({ action: "status", slug });
  assert.equal(status.ok, true);
  assert.equal(status.status.last.ok, true);
});

test("Sync all now sweeps every linked channel once and refuses to stack a second sweep", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  rmSync(calls, { force: true });
  writeFileSync(block, "");
  let first;
  try {
    first = await syncAllNow();
    assert.equal(first.ok, true);
    assert.equal(first.started, true);
    const again = await syncAllNow();
    assert.equal(again.busy, true);
    assert.equal(again.started, false);
    assert.equal((await driveSyncStatusAll()).sweeping, true);
  } finally {
    rmSync(block, { force: true });
  }
  await until(async () => !(await driveSyncStatusAll()).sweeping);
  const all = await driveSyncStatusAll();
  assert.equal(all.channels.length, first.channels);
  assert.ok(all.channels.every((c) => c.last && c.last.ok), "every linked channel recorded a successful pass");
  assert.equal(readCalls().length, first.channels, "one pass per linked channel, no duplicate sweep");
});

test("a wedged sync says so, DMs the admins once a day, and an admin Resync recovers it", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const slug = await addChannel("C_DS_WEDGE", "ds-wedge", "https://drive.google.com/drive/folders/FID_WEDGE_123");
  await syncChannelNow(slug, { waitMs: 5000 }); // the baseline --resync
  rmSync(calls, { force: true });
  notices.length = 0;
  writeFileSync(wedged, "");
  try {
    const failed = await syncChannelNow(slug, { waitMs: 5000 });
    assert.equal(failed.status.last.ok, false);
    assert.equal(failed.status.last.needsResync, true);
    assert.equal(failed.status.last.summary, NEEDS_RESYNC_SUMMARY);
    assert.doesNotMatch(readCalls()[0], /--resync/, "the gateway never resyncs a wedged channel on its own");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].slug, slug);
    assert.match(notices[0].text, /ds-wedge/);
    assert.match(notices[0].text, /Resync/);

    await syncChannelNow(slug, { waitMs: 5000 }); // still wedged, same day
    assert.equal(notices.length, 1, "at most one notice a day per channel");

    const resynced = await syncChannelNow(slug, { waitMs: 5000, trigger: "admin-ui", resync: true });
    assert.equal(resynced.status.last.ok, true);
    assert.equal(resynced.status.last.needsResync, false);
    assert.equal(resynced.status.last.firstRun, true);
    assert.match(readCalls().at(-1), /--resync/);
  } finally {
    rmSync(wedged, { force: true });
  }
  // Recovered: a later wedge is news again.
  writeFileSync(wedged, "");
  try {
    await syncChannelNow(slug, { waitMs: 5000 });
    assert.equal(notices.length, 2, "a recovered channel's next wedge notifies again");
  } finally {
    rmSync(wedged, { force: true });
  }
});

test("a pass never starts beside an earlier pass's container, and an orphan is removed after the grace", async () => {
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: bin });
  const slug = await addChannel("C_DS_ORPH", "ds-orph", "https://drive.google.com/drive/folders/FID_ORPH_123");
  await syncChannelNow(slug, { waitMs: 5000 });
  rmSync(calls, { force: true });
  const orphan = `cg-drivesync-${slug}-0a1b2c3d`;
  probe.running = [orphan];
  probe.removed = [];
  probe.graceMs = 60 * 60 * 1000;
  try {
    const skipped = await syncChannelNow(slug, { waitMs: 5000 });
    assert.equal(skipped.done, true);
    assert.deepEqual(readCalls(), [], "no second bisync beside a running one (it would race for the lock)");
    assert.deepEqual(probe.removed, [], "a possibly-live pass is left alone");

    probe.graceMs = 0; // the same container, now watched for longer than any pass may run
    const ran = await syncChannelNow(slug, { waitMs: 5000 });
    assert.equal(ran.status.last.ok, true);
    assert.deepEqual(probe.removed, [orphan], "the orphan is removed before the pass");
    assert.equal(readCalls().length, 1);
  } finally {
    probe.running = [];
    delete probe.graceMs;
  }
});

test("an rclone that can recover gets --resilient --recover --max-lock; an older one does not", async () => {
  const modern = path.join(fake, "rclone-modern");
  writeFileSync(modern, `#!/bin/sh
[ "$1" = version ] && { echo "rclone v1.75.1"; exit 0; }
exec "${bin}" "$@"
`);
  chmodSync(modern, 0o755);
  await saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: SA_JSON, driveSyncRclonePath: modern });
  const slug = await addChannel("C_DS_RECOV", "ds-recov", "https://drive.google.com/drive/folders/FID_RECOV_123");
  rmSync(calls, { force: true });
  await syncChannelNow(slug, { waitMs: 5000 });
  assert.match(readCalls()[0], /--resilient --recover --max-lock 30m/);

  await saveSettings({ driveSyncRclonePath: bin }); // `version` prints no version: flags withheld
  rmSync(calls, { force: true });
  await syncChannelNow(slug, { waitMs: 5000 });
  assert.doesNotMatch(readCalls()[0], /--recover/);
});
