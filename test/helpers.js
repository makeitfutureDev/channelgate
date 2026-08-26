// Shared scratch environment for tests that touch the config store / SQLite DB. Idempotent per
// process: the first caller creates a temp gateway dir and points the env at it; later callers
// (other test files loaded into the same process via index.js) reuse it. Call this BEFORE
// importing any src module that opens the DB, so getDb() opens the scratch file — never the real
// ~/.channelgate one.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureTestEnv() {
  if (!process.env.CG_TEST_SCRATCH) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cg-test-"));
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
