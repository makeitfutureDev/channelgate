// Shared scratch environment for tests that touch the config store / SQLite DB. Idempotent per
// process: the first caller creates a temp gateway dir and points the env at it; later callers
// (other test files loaded into the same process via index.js) reuse it. Call this BEFORE
// importing any src module that opens the DB, so getDb() opens the scratch file — never the real
// ~/.channelgate one.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Scratch directories (see scripts/test-scratch-sweep.mjs) ──────────────────────────────────
// Every temp directory the suite makes through this module is remembered and removed when the
// process exits. `node --test` gives each test FILE its own process, so a per-process exit handler
// is COMPLETE cleanup for that file — nothing has to survive into the next one.
//
// This exists because nothing used to remove them. One `npm test` left roughly three hundred
// directories in os.tmpdir() (a scratch root plus its TMPDIR sibling per file, plus the per-test
// dirs), and on a tmpfs /tmp with a fixed inode budget forty thousand of them exhausted the inodes
// and started failing unrelated work with "unable to open database file". The `pretest` sweeper
// clears whatever an earlier crash (or a SIGKILL, which runs no handler) still left behind.
const scratchDirs = new Set();
let cleanupInstalled = false;

function installScratchCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // Best effort by construction: an exit handler runs synchronously and must never throw, or a
  // green suite would end in a failed process over a directory nobody needs. A subtree we cannot
  // remove (another user's file under a sticky /tmp, a container-created tree owned by a sub-uid)
  // is left for the sweeper rather than turned into a test failure.
  process.on("exit", () => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 1 });
      } catch {
        /* not removable from here — the sweeper retries it on the next run */
      }
    }
    scratchDirs.clear();
  });
}

// Create a temp directory that is removed when this test process exits. Use this everywhere in the
// suite instead of a bare `mkdtempSync(path.join(os.tmpdir(), …))`.
// Canonical (realpath) on purpose: macOS's os.tmpdir() is /var/folders/…, a symlink to
// /private/var/…, and the code under test resolves REAL paths — credential files, toolchain
// binaries, custom work dirs — so a fixture built from the symlinked form never string-matches what
// the code reports (13 macOS-only CI failures, 2026-09-03; Linux reproduces them with a symlinked
// TMPDIR). Everything derived from this root, including the TMPDIR sibling below, inherits the
// canonical form.
export function tempDir(prefix = "cg-test-") {
  return trackTempDir(realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix))));
}

// Register a directory created some other way (a fixed path a unix socket's 108-char limit forces,
// an async mkdtemp) for the same cleanup. Returns the path so it can be used inline.
export function trackTempDir(dir) {
  installScratchCleanup();
  scratchDirs.add(dir);
  return dir;
}

// What is registered so far. The child process in test/test-scratch-cleanup.test.js reports these
// back to its parent, which then proves they are gone once the child has exited.
export function trackedTempDirs() {
  return [...scratchDirs];
}

export function ensureTestEnv() {
  if (!process.env.CG_TEST_SCRATCH) {
    const dir = tempDir("cg-test-");
    process.env.CG_TEST_SCRATCH = dir;
    process.env.CHANNELGATE_DIR = dir;
    process.env.CHANNELGATE_DB = path.join(dir, "gateway.db");
    // Both roots are pinned: an unset CG_WORKSPACE_DIR would put channel work folders in the
    // developer's real ~/ChannelGate.
    process.env.CG_WORKSPACE_DIR ||= path.join(dir, "workspace");
    // A scratch CODEX_HOME with a stub credential. Two reasons: the Codex state dir is otherwise
    // the developer's real ~/.codex (tests would create directories in it), and the runner now
    // refuses to spawn a signed-OUT Codex — without this every Codex test would exercise the
    // failover path instead of the path it means to test.
    const codexHome = path.join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { refresh_token: "test-refresh-token" } }));
    process.env.CODEX_HOME = codexHome;
    // A scratch CLAUDE_CONFIG_DIR, for the same two reasons and one sharper one. The Claude state
    // dir is otherwise the developer's real ~/.claude (tests would plant symlinks in the engine
    // home pointing at it), and since src/gateway/claude-login.js resolves the OPERATOR's login
    // there first, an unpinned test would read the developer's live credentials file and behave
    // differently on every machine. Empty by default; a test that wants an operator login writes
    // its own fixture into it.
    const claudeConfigDir = path.join(dir, "claude-home", ".claude");
    mkdirSync(claudeConfigDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    // A stub OPERATOR login in that scratch dir. Every channel turn runs in a container and is
    // fail-closed on the relayed Claude login (src/gateway/run.js), so a suite with no login at
    // all could not spawn a single stub turn. Far expiry: no refresh turn is ever attempted. A
    // test about the login itself removes or rewrites this file first (the relay and container
    // credential tests do).
    writeFileSync(path.join(claudeConfigDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-test-suite", refreshToken: "never-relayed", expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, refreshTokenExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, subscriptionType: "test" },
    }), { mode: 0o600 });
    // The stub engines (test/fixtures) drop their hand-off files in $TMPDIR. The shared system
    // tmp is not per-run and not per-user: a file left there by ANOTHER user's test run (two
    // gateways share this host) blocks ours with EACCES. Pin it to the scratch dir like the roots.
    // A SIBLING of the scratch root, never inside it: the scratch root doubles as the daemon root
    // (CHANNELGATE_DIR) and several tests assert that nothing under the daemon root reaches an
    // engine, or create custom work dirs under os.tmpdir() that must resolve OUTSIDE it.
    const tmp = trackTempDir(path.join(path.dirname(dir), `cg-tmp-${path.basename(dir)}`)); // no shared string prefix with dir
    mkdirSync(tmp, { recursive: true });
    process.env.TMPDIR = tmp;
  }
  process.env.CG_APPROVAL_SECRET ||= "test-only-gateway-signing-secret";
  ensureTestLicense();
  return process.env.CG_TEST_SCRATCH;
}

// ── License (src/ee/) ─────────────────────────────────────────────────────────────────────────
// The run orchestrator admits every turn through licenseAdmission(), so an unlicensed scratch
// environment would serve exactly ONE conversation per UTC month and refuse the rest — correct
// product behaviour, and completely wrong as a test default: the suite drives dozens of channels
// through run.js to exercise things that have nothing to do with licensing.
//
// So the scratch environment is an ENTERPRISE deployment, established the same way an air-gapped
// one is: a license payload signed with a keypair minted for this process, and the matching public
// key in CHANNELGATE_LICENSE_PUBLIC_KEY. Nothing is stubbed and no check is disabled — src/ee
// verifies this signature exactly as it would verify the platform's. Tests that are ABOUT
// licensing call testLicenseEnv()/clearTestLicense() to install their own state.
export const TEST_LICENSE_KEY = "cg-test-enterprise-key";

let testKeyPair = null;

// The keypair every test license is signed with. Minted once per process.
export function testLicenseKeyPair() {
  if (!testKeyPair) testKeyPair = generateKeyPairSync("ed25519");
  return testKeyPair;
}

export function testLicensePublicKeyPem() {
  return testLicenseKeyPair().publicKey.export({ type: "spki", format: "pem" });
}

// Canonical JSON — the same encoding src/ee/tiers.js signs over. Duplicated here on purpose: a
// test that computed its signature with the implementation's own encoder could not catch the
// encoder drifting.
export function testCanonicalJson(value) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

export function signTestLicense(license, privateKey = testLicenseKeyPair().privateKey) {
  return edSign(null, Buffer.from(testCanonicalJson(license), "utf8"), privateKey).toString("base64url");
}

export function makeTestLicense({
  tier = "enterprise",
  limits = { conversations: null, messagesPerConversationPerMonth: null },
  organization = "ChannelGate test suite",
  keyId = "test-key-id",
  issuedAt = "2026-01-01T00:00:00.000Z",
  expiresAt = null,
} = {}) {
  return { tier, limits, organization, keyId, issuedAt, expiresAt };
}

// Install a signed license into the environment. Returns the payload so a test can assert on it.
export function testLicenseEnv(overrides = {}) {
  const license = makeTestLicense(overrides);
  const payload = { ok: true, license, signature: signTestLicense(license) };
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  process.env.CHANNELGATE_LICENSE_PAYLOAD = JSON.stringify({ license: payload.license, signature: payload.signature });
  process.env.CHANNELGATE_LICENSE_KEY = TEST_LICENSE_KEY;
  return payload;
}

// Drop back to an unlicensed deployment (the no-key tier) — what a fresh install looks like.
export function clearTestLicense() {
  delete process.env.CHANNELGATE_LICENSE_PAYLOAD;
  delete process.env.CHANNELGATE_LICENSE_KEY;
}

function ensureTestLicense() {
  if (!process.env.CHANNELGATE_LICENSE_PAYLOAD) testLicenseEnv();
  // Never let a test reach the real platform: an unroutable base URL makes any accidental
  // verification a fast, harmless failure instead of an outbound request from CI.
  process.env.CHANNELGATE_PLATFORM_URL ||= "http://127.0.0.1:9/channelgate/api";
}
