// Pure helpers of the Google Drive sync engine (gateway/drivesync.js): link → folder-id parsing,
// the rclone bisync/test argv builders, and channel selection. Uses a throwaway gateway env because
// the module imports the store/settings/folders modules (whose DB access is lazy, but the env must
// exist before import so nothing touches the real ~/.claude-gateway).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmodSync, statSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { parseDriveFolderId, syncRoot, buildDriveFilters, syncIdentity, DRIVE_SYNC_EXCLUDES, symlinkExcludes, driveSyncFolderRefusal, buildBisyncArgs, buildTestArgs, selectSyncChannels, isServiceAccountJson, resolveDriveSyncKeyFile, driveSyncResultOutput, needsResync, resyncSentinel, priorListingEmpty, rcloneAvailable } = await import("../src/gateway/drivesync.js");
const { saveSettings } = await import("../src/config/settings.js");
const { configDir } = await import("../src/config/paths.js");

const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "p",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  client_email: "bot@p.iam.gserviceaccount.com",
});

test("parseDriveFolderId handles every link shape", () => {
  assert.equal(parseDriveFolderId("https://drive.google.com/drive/folders/1AbC-dEfG_hIjKlmno"), "1AbC-dEfG_hIjKlmno");
  assert.equal(parseDriveFolderId("https://drive.google.com/drive/u/0/folders/1AbC-dEfG_hIjKlmno?usp=sharing"), "1AbC-dEfG_hIjKlmno");
  assert.equal(parseDriveFolderId("https://drive.google.com/open?id=1AbC-dEfG_hIjKlmno"), "1AbC-dEfG_hIjKlmno");
  assert.equal(parseDriveFolderId("1AbC-dEfG_hIjKlmno"), "1AbC-dEfG_hIjKlmno"); // bare id
  assert.equal(parseDriveFolderId("  1AbC-dEfG_hIjKlmno  "), "1AbC-dEfG_hIjKlmno"); // trimmed
});

test("parseDriveFolderId rejects junk", () => {
  assert.equal(parseDriveFolderId(""), null);
  assert.equal(parseDriveFolderId("   "), null);
  assert.equal(parseDriveFolderId("not a link"), null);
  assert.equal(parseDriveFolderId("https://drive.google.com/drive/my-drive"), null);
  assert.equal(parseDriveFolderId(null), null);
  assert.equal(parseDriveFolderId(undefined), null);
});

test("the whole channel folder is the local side of the sync", () => {
  // QA-0925: the owner wanted the channel in Drive, not a Drive/ subfolder of it.
  assert.equal(syncRoot("/work/chan-a"), "/work/chan-a");
});

test("buildBisyncArgs: steady-state pass has no --resync and carries auth + scope", () => {
  const args = buildBisyncArgs({
    localPath: "/work/chan-a/Drive",
    folderId: "FID",
    keyFile: "/keys/sa.json",
    subject: "",
    workDir: "/state/chan-a",
    conflict: "newer",
    firstRun: false,
  });
  assert.equal(args[0], "bisync");
  assert.equal(args[1], "/work/chan-a/Drive");
  assert.equal(args[2], ":drive:");
  assert.ok(args.includes("--drive-service-account-file") && args.includes("/keys/sa.json"));
  assert.ok(args.includes("--drive-root-folder-id") && args.includes("FID"));
  assert.ok(args.includes("--workdir") && args.includes("/state/chan-a"));
  assert.ok(args.includes("--conflict-resolve") && args.includes("newer"));
  assert.ok(!args.includes("--resync")); // steady state
  assert.ok(!args.includes("--drive-impersonate")); // no subject
});

test("buildBisyncArgs: first run adds --resync; a subject adds --drive-impersonate", () => {
  const args = buildBisyncArgs({
    localPath: "/work/chan-a/Drive",
    folderId: "FID",
    keyFile: "/keys/sa.json",
    subject: "bot@corp.com",
    workDir: "/state/chan-a",
    conflict: "path2",
    firstRun: true,
  });
  const i = args.indexOf("--resync");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "--resync-mode");
  assert.equal(args[i + 2], "path2"); // resync mode tracks the conflict policy
  assert.ok(args.includes("--drive-impersonate") && args.includes("bot@corp.com"));
});

test("buildTestArgs lists the folder read-only with the same auth", () => {
  const args = buildTestArgs({ folderId: "FID", keyFile: "/keys/sa.json", subject: "" });
  assert.equal(args[0], "lsf");
  assert.ok(args.includes(":drive:"));
  assert.ok(args.includes("--drive-root-folder-id") && args.includes("FID"));
  assert.ok(args.includes("--drive-service-account-file"));
});

test("Drive sync fallback results explain failure without exposing a process code", () => {
  assert.equal(driveSyncResultOutput({ ok: true, tail: "" }), "OK — folder reachable (empty).");
  assert.equal(
    driveSyncResultOutput({
      ok: false,
      code: 1,
      tail: "",
      outcome: { ok: false, kind: "failed", summary: "failed because it reported a general error" },
    }),
    "Drive sync failed because it reported a general error.",
  );
  assert.doesNotMatch(driveSyncResultOutput({ ok: false, code: 37, tail: "" }), /exit code|code 37/i);
});

test("isServiceAccountJson accepts a real key and reports the email", () => {
  const r = isServiceAccountJson(SA_JSON);
  assert.equal(r.ok, true);
  assert.equal(r.email, "bot@p.iam.gserviceaccount.com");
});

test("isServiceAccountJson rejects junk / wrong type / missing fields", () => {
  assert.equal(isServiceAccountJson("not json").ok, false);
  assert.equal(isServiceAccountJson(JSON.stringify({ type: "authorized_user" })).ok, false);
  assert.equal(isServiceAccountJson(JSON.stringify({ type: "service_account", client_email: "x" })).ok, false); // no private_key
  assert.equal(isServiceAccountJson(JSON.stringify({ type: "service_account", private_key: "x" })).ok, false); // no client_email
});

test("resolveDriveSyncKeyFile materializes pasted JSON to a chmod-600 file, then clears it", () => {
  saveSettings({ driveSyncKeyJson: SA_JSON, driveSyncKeyFile: "" });
  const p = resolveDriveSyncKeyFile();
  assert.equal(p, path.join(configDir(), "drive-sa.json"));
  assert.equal(readFileSync(p, "utf8"), SA_JSON);
  assert.equal(statSync(p).mode & 0o777, 0o600); // private-key file must not be group/other readable
  // Clearing the JSON removes the managed file; with no fallback path configured, resolves to "".
  saveSettings({ driveSyncKeyJson: "" });
  assert.equal(resolveDriveSyncKeyFile(), "");
  assert.equal(existsSync(p), false);
});

test("selectSyncChannels keeps only channels with a parseable link, carrying meta", () => {
  const metaA = { syncDriveFolder: "https://drive.google.com/drive/folders/FID1", workDir: "/custom/a" };
  const picked = selectSyncChannels([
    { slug: "a", channelId: "C1", name: "a", meta: metaA },
    { slug: "b", channelId: "C2", name: "b", meta: { syncDriveFolder: "" } }, // off
    { slug: "c", channelId: "C3", name: "c", meta: { syncDriveFolder: "garbage" } }, // unparseable
    { slug: "d", channelId: "C4", name: "d", meta: {} }, // no field
    { slug: "e", channelId: "C5", name: "e", meta: null }, // no meta
  ]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].slug, "a");
  assert.equal(picked[0].folderId, "FID1");
  assert.equal(picked[0].meta, metaA); // carried through so the sync honors a custom workDir
});

test("a crash mid-first-sync no longer wedges a channel into permanent non-resync mode", () => {
  const base = tempDir("cg-drivesync-");

  // Nothing on disk: bisync has no baseline, so this pass must carry --resync.
  const fresh = path.join(base, "fresh");
  assert.equal(needsResync(fresh), true);

  // The wedge: rclone's working dir has to exist BEFORE the --resync runs, so a reboot or daemon
  // crash mid-first-sync leaves it behind. Keying "already resynced" on that directory made every
  // later tick omit --resync, rclone abort with "cannot find prior listing", and firstRun stay false
  // forever. The half-built baseline must still read as a first run.
  const crashed = path.join(base, "crashed");
  mkdirSync(crashed, { recursive: true });
  writeFileSync(path.join(crashed, "listing.lst"), "half a baseline\n");
  assert.equal(needsResync(crashed), true);

  // Only a COMPLETED pass earns the sentinel, and only then does steady state begin.
  writeFileSync(resyncSentinel(crashed), "2026-08-19T00:00:00.000Z\n");
  assert.equal(needsResync(crashed), false);
  assert.equal(resyncSentinel(crashed), path.join(crashed, ".resync-complete"));

  // The argv builder is driven by exactly that answer.
  const argsFor = (stateDir) =>
    buildBisyncArgs({ localPath: "/work/Drive", folderId: "FID", keyFile: "/keys/sa.json", subject: "", workDir: stateDir, firstRun: needsResync(stateDir) });
  assert.ok(argsFor(fresh).includes("--resync"));
  assert.ok(!argsFor(crashed).includes("--resync"));
});

test("only a listing that records no file forces another --resync; any other missing listing stays an error", () => {
  // QA-0925: a channel linked to an empty Drive folder resynced two empty sides, then every later
  // tick failed "Empty prior Path1 listing … Must run --resync to recover" — forever.
  const dir = tempDir("drivesync-listing");
  assert.equal(priorListingEmpty(path.join(dir, "absent")), false, "no state dir: the sentinel decides, not this");
  assert.equal(priorListingEmpty(dir), false, "no listing files at all stays an error");
  const p1 = path.join(dir, "local_Drive.._drive_.path1.lst");
  const p2 = path.join(dir, "local_Drive.._drive_.path2.lst");
  writeFileSync(p1, "# bisync listing v1 from 2026-09-25T10:21:21Z\n");
  assert.equal(priorListingEmpty(dir), false, "one side missing is not the empty-resync shape");
  writeFileSync(p2, "# bisync listing v1 from 2026-09-25T10:21:21Z\n");
  assert.equal(priorListingEmpty(dir), true, "two header-only listings record no file");
  writeFileSync(p1, '# bisync listing v1\n-        2 - - 2026-09-25T10:41:39Z "s.txt"\n');
  assert.equal(priorListingEmpty(dir), false, "a listing that records a file is never resynced over");
  // A channel ALREADY wedged in production: rclone renamed the empty listings to .lst-err.
  const wedged = tempDir("drivesync-wedged");
  writeFileSync(path.join(wedged, "x.path1.lst-err"), "# header\n");
  writeFileSync(path.join(wedged, "x.path2.lst-err"), "# header\n");
  assert.equal(priorListingEmpty(wedged), true, "header-only .lst-err on both sides recovers");
  // A deliberate delete-everything: rclone aborts and renames NON-empty listings to .lst-err.
  // Resyncing here would copy every deleted file back, so it must stay an error.
  const deleted = tempDir("drivesync-deleted");
  writeFileSync(path.join(deleted, "x.path1.lst-err"), '# header\n-  2 - - t "a.txt"\n');
  writeFileSync(path.join(deleted, "x.path2.lst-err"), '# header\n-  2 - - t "a.txt"\n');
  assert.equal(priorListingEmpty(deleted), false);
  const partial = tempDir("drivesync-partial");
  writeFileSync(path.join(partial, "x.path2.lst-new"), '-  2 - - t "a"\n');
  assert.equal(priorListingEmpty(partial), false, "a crashed pass's .lst-new leftovers never trigger a resync");
  const source = readFileSync(new URL("../src/gateway/drivesync.js", import.meta.url), "utf8");
  assert.match(source, /const firstRun = initial \|\| priorListingEmpty\(stateDir\);/);
  assert.match(source, /if \(initial\) \{ try \{ rmSync\(stateDir/, "a failed FORCED resync keeps its state");
});

test("real rclone: two empty sides, then a new file, syncs once the empty listing forces --resync", { skip: !rcloneAvailable("rclone") && "rclone not installed" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const root = tempDir("drivesync-rclone");
  const a = path.join(root, "a"), b = path.join(root, "b"), w = path.join(root, "w");
  for (const d of [a, b, w]) mkdirSync(d, { recursive: true });
  const bisync = (resync) => spawnSync("rclone", ["bisync", a, b, "--workdir", w, "--create-empty-src-dirs", ...(resync ? ["--resync", "--resync-mode", "newer"] : []), "-q"], { encoding: "utf8" });
  assert.equal(bisync(true).status, 0, "first --resync of two empty sides succeeds");
  assert.equal(priorListingEmpty(w), true, "…and leaves an empty prior listing behind");
  writeFileSync(path.join(a, "x.txt"), "hi\n");
  assert.equal(bisync(false).status, 7, "the unpatched steady-state pass is rclone's critical exit 7");
  const fixed = bisync(priorListingEmpty(w));
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(readFileSync(path.join(b, "x.txt"), "utf8"), "hi\n", "the new file reached the other side");
  assert.equal(priorListingEmpty(w), false, "and the next pass is an ordinary bisync");
});

test("real rclone: deleting every file on one side is never undone by a forced resync", { skip: !rcloneAvailable("rclone") && "rclone not installed" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const root = tempDir("drivesync-rclone-delete");
  const a = path.join(root, "a"), b = path.join(root, "b"), w = path.join(root, "w");
  for (const d of [a, b, w]) mkdirSync(d, { recursive: true });
  for (const n of ["1", "2", "3"]) writeFileSync(path.join(a, `${n}.txt`), n);
  const bisync = (resync) => spawnSync("rclone", ["bisync", a, b, "--workdir", w, ...(resync ? ["--resync", "--resync-mode", "newer"] : []), "-q"], { encoding: "utf8" });
  assert.equal(bisync(true).status, 0);
  assert.equal(bisync(false).status, 0, "a normal pass after the baseline");
  for (const n of ["1", "2", "3"]) rmSync(path.join(a, `${n}.txt`));
  assert.notEqual(bisync(false).status, 0, "rclone refuses to empty a side");
  assert.equal(priorListingEmpty(w), false, "so the gateway must NOT resync (that would restore the files)");
  assert.equal(existsSync(path.join(a, "1.txt")), false, "the deletion still stands");
});

test("the filters keep the lockdown, memory and secrets out of Drive, and .driveignore only ever narrows", () => {
  const dir = tempDir("drivesync-filters");
  const base = buildDriveFilters(dir);
  for (const pattern of [".claude/**", ".agents/**", ".codex/**", "CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.local.md", ".mcp.json", "/MEMORY.md", "/memory/**", "/runtime/env/**", ".env", ".env.*", ".ssh/**", "*.pem", ".git", ".git/**", "node_modules/**", "*.rclonelink", "/.driveignore"]) {
    assert.ok(base.split("\n").includes(`- ${pattern}`), pattern);
  }
  assert.equal(base.split("\n").filter(Boolean).length, DRIVE_SYNC_EXCLUDES.length);
  writeFileSync(path.join(dir, ".driveignore"), "# big intermediate data\n_reindex/**\n\n+ /.claude/**\n- *.tmp\n");
  const custom = buildDriveFilters(dir).split("\n").filter(Boolean);
  assert.deepEqual(custom.slice(DRIVE_SYNC_EXCLUDES.length), ["- _reindex/**", "- /.claude/**", "- *.tmp"], "every line is an exclude; a '+' can never re-include the scaffolding");
  assert.equal(custom.some((line) => line.startsWith("+")), false);
});

test("a changed local root, Drive folder or filter set forces a fresh --resync", () => {
  const a = syncIdentity({ localPath: "/w", folderId: "F", filters: "- x\n" });
  assert.notEqual(a, syncIdentity({ localPath: "/w/Drive", folderId: "F", filters: "- x\n" }));
  assert.notEqual(a, syncIdentity({ localPath: "/w", folderId: "G", filters: "- x\n" }));
  assert.notEqual(a, syncIdentity({ localPath: "/w", folderId: "F", filters: "- y\n" }));
  const stateDir = tempDir("drivesync-identity");
  assert.equal(needsResync(stateDir, a), true, "no sentinel");
  writeFileSync(resyncSentinel(stateDir), "2026-09-25T10:21:21.141Z\n");
  assert.equal(needsResync(stateDir, a), true, "a sentinel from before identities (the Drive/ subfolder era) resyncs once");
  assert.equal(needsResync(stateDir), false, "without an identity only the sentinel's presence counts");
  writeFileSync(resyncSentinel(stateDir), `${JSON.stringify({ identity: a, at: "t" })}\n`);
  assert.equal(needsResync(stateDir, a), false);
  assert.equal(needsResync(stateDir, syncIdentity({ localPath: "/w", folderId: "G", filters: "- x\n" })), true);
  const args = buildBisyncArgs({ localPath: "/w", folderId: "F", keyFile: "/k", subject: "", workDir: stateDir, filtersFile: "/s/filters.txt", extraExcludes: ["/lk", "/lk/**"] }).join(" ");
  assert.match(args, /--filters-file \/s\/filters\.txt --ignore-case/, "filters match case-insensitively (a Drive-side Claude.md)");
  assert.match(args, /--exclude \/lk --exclude \/lk\/\*\*/, "per-pass symlink excludes ride as flags, outside the filters file");
  const source = readFileSync(new URL("../src/gateway/drivesync.js", import.meta.url), "utf8");
  assert.match(source, /const initial = needsResync\(stateDir, identity\);/);
});

test("every symlink in the folder is excluded for the pass, with its name escaped", () => {
  const dir = tempDir("drivesync-links");
  mkdirSync(path.join(dir, "a b[1]"), { recursive: true });
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  symlinkSync("/etc", path.join(dir, "a b[1]", "lk*"));
  symlinkSync(".claude", path.join(dir, "lnk2"));
  symlinkSync("/etc", path.join(dir, ".git", "not-walked"));
  assert.deepEqual(symlinkExcludes(dir).sort(), ["/a b\\[1\\]/lk\\*", "/a b\\[1\\]/lk\\*/**", "/lnk2", "/lnk2/**"].sort());
});

test("a folder that is or contains the home, the gateway root or the workspace root is refused", () => {
  const home = tempDir("drivesync-home");
  const gw = path.join(home, ".gw"), ws = path.join(home, "WS");
  for (const d of [gw, ws, path.join(ws, "slack", "chan"), path.join(home, "Code", "proj")]) mkdirSync(d, { recursive: true });
  const own = path.join(ws, "slack", "chan");
  const refuse = (dir) => driveSyncFolderRefusal(dir, { home, roots: [gw, ws], ownFolder: own });
  for (const d of [path.join(home, ".ssh"), path.join(home, ".config", "x"), path.join(ws, ".runtime", "slack", "chan"), path.join(ws, "slack", "other")]) mkdirSync(d, { recursive: true });
  assert.match(refuse(path.join(home, ".ssh")), /hidden configuration folder/, "Drive could otherwise write authorized_keys");
  assert.match(refuse(path.join(home, ".config", "x")), /hidden configuration folder/);
  assert.match(refuse(path.join(ws, "slack")), /not this channel's own folder/, "the parent of every Slack channel");
  assert.match(refuse(path.join(ws, ".runtime", "slack", "chan")), /not this channel's own folder/, "secret bundles and MCP configs");
  assert.match(refuse(path.join(ws, "slack", "other")), /not this channel's own folder/, "another channel's folder");
  assert.match(refuse(home), /is or contains/);
  assert.match(refuse(ws), /is or contains/);
  assert.match(refuse("/"), /filesystem root/);
  assert.equal(refuse(path.join(ws, "slack", "chan")), "", "a channel's own folder syncs");
  assert.equal(refuse(path.join(home, "Code", "proj")), "", "a custom project folder syncs");
});

test("real rclone: the whole folder syncs, the scaffolding and secrets never cross in either direction", { skip: !rcloneAvailable("rclone") && "rclone not installed" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const root = tempDir("drivesync-rclone-whole");
  const local = path.join(root, "channel"), remote = path.join(root, "drive"), w = path.join(root, "w");
  for (const d of [local, remote, w, path.join(local, ".claude"), path.join(local, "memory"), path.join(local, "runtime", "env"), path.join(local, "docs")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(local, "CLAUDE.md"), "lockdown\n");
  writeFileSync(path.join(local, ".claude", "settings.json"), "{}\n");
  writeFileSync(path.join(local, "MEMORY.md"), "memory\n");
  writeFileSync(path.join(local, "memory", "topic.md"), "t\n");
  writeFileSync(path.join(local, "runtime", "env", "run.env"), "SECRET=1\n");
  writeFileSync(path.join(local, ".env"), "SECRET=1\n");
  writeFileSync(path.join(local, "notes.md"), "notes\n");
  writeFileSync(path.join(local, "docs", "a.md"), "a\n");
  writeFileSync(path.join(remote, "from-drive.md"), "d\n");
  writeFileSync(path.join(remote, "CLAUDE.md"), "EVIL\n"); // a Drive-side copy must never come down
  const filtersFile = path.join(w, "filters.txt");
  writeFileSync(filtersFile, buildDriveFilters(local));
  const run = (resync) => spawnSync("rclone", ["bisync", local, remote, "--workdir", w, "--filters-file", filtersFile, "--create-empty-src-dirs", ...(resync ? ["--resync", "--resync-mode", "newer"] : []), "-q"], { encoding: "utf8" });
  const first = run(true);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(path.join(remote, "notes.md"), "utf8"), "notes\n");
  assert.equal(readFileSync(path.join(remote, "docs", "a.md"), "utf8"), "a\n");
  assert.equal(readFileSync(path.join(local, "from-drive.md"), "utf8"), "d\n", "Drive files come down");
  for (const hidden of [".claude/settings.json", "MEMORY.md", "memory/topic.md", "runtime/env/run.env", ".env"]) {
    assert.equal(existsSync(path.join(remote, hidden)), false, `${hidden} never reaches Drive`);
  }
  assert.equal(readFileSync(path.join(local, "CLAUDE.md"), "utf8"), "lockdown\n", "the Drive-side CLAUDE.md never overwrites the lockdown");
  writeFileSync(path.join(local, "notes.md"), "notes v2\n");
  const second = run(false);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(path.join(remote, "notes.md"), "utf8"), "notes v2\n", "an ordinary pass carries edits");
});

test("the resync sentinel is written only on a successful pass", () => {
  const source = readFileSync(new URL("../src/gateway/drivesync.js", import.meta.url), "utf8");
  const success = source.indexOf("if (res.ok) {");
  const failure = source.indexOf("} else {", success);
  const write = source.indexOf("writeFileSync(resyncSentinel", success);
  assert.ok(success > 0 && failure > success);
  assert.ok(write > success && write < failure, "a failed --resync must leave the channel in first-run state");
});

test("rclone availability caches hits per path but retries misses after a live install", () => {
  assert.equal(rcloneAvailable(path.join(os.tmpdir(), "cg-absent-rclone-a")), false);
  assert.equal(rcloneAvailable(path.join(os.tmpdir(), "cg-absent-rclone-b")), false);
  if (process.platform !== "win32") {
    // A single global boolean meant the first miss answered for every later path, so fixing the
    // path in Settings did nothing until the daemon restarted. `/bin/echo version` exits 0, which
    // is all the probe asks of a binary.
    assert.equal(rcloneAvailable("/bin/echo"), true);
    const late = path.join(tempDir("cg-rclone-late-"), "rclone");
    assert.equal(rcloneAvailable(late), false);
    writeFileSync(late, "#!/bin/sh\nexit 0\n");
    chmodSync(late, 0o755);
    assert.equal(rcloneAvailable(late), true, "a previously missing binary becomes available without a daemon restart");
    rmSync(late, { force: true });
    assert.equal(rcloneAvailable(late), true, "successful probes remain cached for the same path");
    assert.equal(rcloneAvailable("/bin/echo"), true); // …and so is the hit
  }
});

test("the Drive pass runs in a throwaway confined container that mounts only the folder, the state, the filters and the key", async () => {
  const { createFakeCli } = await import("./container-fake-cli.js");
  const { __setContainerRuntime, __resetContainerRuntime, confinedCommandArgv } = await import("../src/runtimes/container/index.js");
  const fake = createFakeCli({ kind: "podman" });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    const argv = await confinedCommandArgv({
      binds: [{ source: "/w/chan" }, { source: "/s/state" }, { source: "/s/state/filters.txt", readOnly: true }, { source: "/k/sa.json", readOnly: true }, { source: "/opt/rclone", target: "/usr/local/bin/cg-rclone", readOnly: true }],
      entrypoint: "/usr/local/bin/cg-rclone",
      args: ["bisync", "/w/chan", ":drive:"],
      settings: { cli: "podman", image: "channelgate/runtime:latest" },
    });
    const line = argv.join(" ");
    assert.equal(argv[0], "podman");
    assert.deepEqual(argv.slice(1, 4), ["run", "--rm", "--pull=never"], "one-shot, never pulls");
    assert.match(line, /--cap-drop ALL --security-opt no-new-privileges/);
    assert.deepEqual(argv.filter((_, i) => argv[i - 1] === "-v"), ["/w/chan:/w/chan", "/s/state:/s/state", "/s/state/filters.txt:/s/state/filters.txt:ro", "/k/sa.json:/k/sa.json:ro", "/opt/rclone:/usr/local/bin/cg-rclone:ro"],
      "exactly these binds: no home, no gateway root, and the filters and key read-only");
    assert.match(line, /--entrypoint \/usr\/local\/bin\/cg-rclone channelgate\/runtime:latest bisync \/w\/chan :drive:$/);
  } finally {
    __resetContainerRuntime();
  }
  const source = readFileSync(new URL("../src/gateway/drivesync.js", import.meta.url), "utf8");
  assert.match(source, /let launch = confinedRcloneLaunch;/, "the confined launcher is the default");
});

test("the confined launch mounts the state, filters and key at a random path per pass and names the container for cleanup", async () => {
  const { createFakeCli } = await import("./container-fake-cli.js");
  const { __setContainerRuntime, __resetContainerRuntime } = await import("../src/runtimes/container/index.js");
  const { __confinedRcloneLaunch } = await import("../src/gateway/drivesync.js");
  const fake = createFakeCli({ kind: "podman" });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  const bin = path.join(tempDir("drivesync-bin"), "rclone");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  try {
    const seen = [];
    const launch = (n) => __confinedRcloneLaunch({ bin, slug: "chan a", localPath: "/w/chan", stateDir: "/s/state", filtersFile: "/s/state/filters.txt", keyFile: "/k/sa.json",
      buildArgs: (p) => { seen.push(p); return ["bisync", p.localPath, ":drive:", "--workdir", p.stateDir, "--filters-file", p.filtersFile, "--drive-service-account-file", p.keyFile]; } });
    const one = await launch();
    const two = await launch();
    const binds = one.argv.filter((_, i) => one.argv[i - 1] === "-v");
    const base = seen[0].stateDir.replace(/\/state$/, "");
    assert.match(base, /^\/cg-sync-[0-9a-f]{24}$/);
    assert.notEqual(seen[1].stateDir, seen[0].stateDir, "a new random path every pass");
    assert.equal(seen[0].localPath, "/w/chan", "the work folder keeps its real path");
    assert.deepEqual(binds, ["/w/chan:/w/chan", `/s/state:${base}/state`, `/s/state/filters.txt:${base}/state/filters.txt:ro`, `/k/sa.json:${base}/key.json:ro`, `${bin}:/usr/local/bin/cg-rclone:ro`]);
    assert.ok(!binds.some((b) => b.split(":")[1].startsWith("/s/") || b.split(":")[1].startsWith("/k/")), "no host path of the state or key exists inside");
    const name = one.argv[one.argv.indexOf("--name") + 1];
    assert.match(name, /^cg-drivesync-chan-a-[0-9a-f]{8}$/);
    assert.notEqual(name, two.argv[two.argv.indexOf("--name") + 1]);
    assert.equal(typeof one.cleanup, "function", "a timed-out pass force-removes its container");
  } finally {
    __resetContainerRuntime();
  }
});
