// Pure helpers of the Google Drive sync engine (gateway/drivesync.js): link → folder-id parsing,
// the rclone bisync/test argv builders, and channel selection. Uses a throwaway gateway env because
// the module imports the store/settings/folders modules (whose DB access is lazy, but the env must
// exist before import so nothing touches the real ~/.claude-gateway).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { parseDriveFolderId, syncSubdir, buildBisyncArgs, buildTestArgs, selectSyncChannels, isServiceAccountJson, resolveDriveSyncKeyFile, driveSyncResultOutput, needsResync, resyncSentinel, rcloneAvailable } = await import("../src/gateway/drivesync.js");
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

test("syncSubdir isolates the sync into a Drive/ subfolder", () => {
  assert.equal(syncSubdir("/work/chan-a"), path.join("/work/chan-a", "Drive"));
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

test("the resync sentinel is written only on a successful pass", () => {
  const source = readFileSync(new URL("../src/gateway/drivesync.js", import.meta.url), "utf8");
  const success = source.indexOf("if (res.ok) {");
  const failure = source.indexOf("} else {", success);
  const write = source.indexOf("writeFileSync(resyncSentinel", success);
  assert.ok(success > 0 && failure > success);
  assert.ok(write > success && write < failure, "a failed --resync must leave the channel in first-run state");
});

test("rclone availability is cached per binary path, so correcting a wrong path takes effect", () => {
  assert.equal(rcloneAvailable(path.join(os.tmpdir(), "cg-absent-rclone-a")), false);
  assert.equal(rcloneAvailable(path.join(os.tmpdir(), "cg-absent-rclone-b")), false);
  if (process.platform !== "win32") {
    // A single global boolean meant the first miss answered for every later path, so fixing the
    // path in Settings did nothing until the daemon restarted. `/bin/echo version` exits 0, which
    // is all the probe asks of a binary.
    assert.equal(rcloneAvailable("/bin/echo"), true);
    assert.equal(rcloneAvailable(path.join(os.tmpdir(), "cg-absent-rclone-a")), false); // still remembered
    assert.equal(rcloneAvailable("/bin/echo"), true); // …and so is the hit
  }
});
