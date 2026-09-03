// The CLI catalog after the Settings → Network → "CLI integrations" switch was retired
// (2026-09-03, Linux + containers only): the catalog now feeds the `/secrets` name suggestions and
// the host-sandbox write-deny list, and nothing links a shared host login into a run any more.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [
  { CLI_INTEGRATIONS, GIT_TOOLING_HOME_PATHS, allCliCredentialHomePaths, cliEnvKeys, cliIntegrationIds, normalizeCliIntegrations },
  { saveSettings, getEffectiveNetworkDomains, getNetworkDomains, getCredentialHomePaths, settingsForApi },
  { buildSettings },
  { normalizeNetworkDomains, normalizeRequestedDomain, normalizeStoredDomains },
] = await Promise.all([
  import("../src/config/cli-catalog.js"),
  import("../src/config/settings.js"),
  import("../src/gateway/folders.js"),
  import("../src/util/network-domains.js"),
]);

const sandboxPath = (p) => `/${p.replace(/^\/+/, "")}`;

test("every catalog entry ships normalizable domains and HOME-relative credential paths", () => {
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    assert.deepEqual(normalizeNetworkDomains(entry.domains), entry.domains, id);
    assert.ok(entry.label, id);
    for (const rel of entry.credentialHomePaths) {
      assert.ok(!path.isAbsolute(rel) && !rel.startsWith(".."), `${id}: ${rel} must stay inside HOME`);
    }
  }
});

test("normalizeCliIntegrations drops unknown ids, dedupes, and never throws on junk", () => {
  assert.deepEqual(normalizeCliIntegrations(["vercel", "VERCEL", "nope", 7, null, "supabase"]), ["vercel", "supabase"]);
  assert.deepEqual(normalizeCliIntegrations("vercel"), []);
  assert.deepEqual(normalizeCliIntegrations(undefined), []);
});

test("the /secrets suggestions cover every catalog env name — there is no per-gateway switch any more", () => {
  const suggested = cliEnvKeys(cliIntegrationIds());
  for (const entry of Object.values(CLI_INTEGRATIONS)) for (const key of entry.envKeys) assert.ok(suggested.includes(key), key);
  assert.ok(suggested.includes("SUPABASE_ACCESS_TOKEN") && suggested.includes("VERCEL_TOKEN") && suggested.includes("MAKE_API_TOKEN"));
});

test("a stored cliIntegrations value is inert: no domains, no host logins, not in the public settings", () => {
  // A settings.json written before the retirement still carries the key; it must not grant anything.
  saveSettings({ cliIntegrations: ["vercel", "supabase"], networkDomains: [] });
  assert.deepEqual(getEffectiveNetworkDomains(), getNetworkDomains());
  assert.ok(!getEffectiveNetworkDomains().includes("api.vercel.com"));
  assert.deepEqual(getCredentialHomePaths(), GIT_TOOLING_HOME_PATHS);
  const pub = settingsForApi();
  assert.equal("cliIntegrations" in pub, false);
  assert.equal("cliIntegrationCatalog" in pub, false);
  saveSettings({ cliIntegrations: [] });
});

test("a bash+network host sandbox reads the git/gh baseline only, never a provider login", async () => {
  const s = await buildSettings({ _slug: "cli-probe", allowBash: true, allowNetwork: true, allowedMcps: [] });
  const home = os.homedir();
  for (const rel of GIT_TOOLING_HOME_PATHS) {
    assert.ok(s.sandbox.filesystem.allowRead.includes(sandboxPath(path.join(home, rel))), rel);
  }
  for (const rel of allCliCredentialHomePaths()) {
    const p = sandboxPath(path.join(home, rel));
    assert.ok(!s.sandbox.filesystem.allowRead.includes(p), `${p} must not be readable`);
    assert.ok(!(s.sandbox.filesystem.allowWrite || []).includes(p), `${p} must never be writable`);
  }
  assert.ok(!s.sandbox.network.allowedDomains.includes("api.vercel.com"));
});

test("network-off channels get no credential carve-outs at all", async () => {
  const s = await buildSettings({ _slug: "cli-probe-off", allowBash: true, allowNetwork: false, allowedMcps: [] });
  assert.equal(s.sandbox.network, undefined);
  const home = os.homedir();
  for (const rel of [...GIT_TOOLING_HOME_PATHS, ...allCliCredentialHomePaths()]) {
    assert.ok(!s.sandbox.filesystem.allowRead.includes(sandboxPath(path.join(home, rel))));
  }
});

// The gap found in an ops channel: an admin-mode channel with Bash OFF is the most
// privileged run yet was the only network-on mode that could never read the git credentials.
// The ADMIN-RUN variant (allowBypass) gets the credential re-allows; the shared settings
// file for the same channel must NOT (non-admin authors keep the narrow contract).
test("admin-run variant of a no-bash network channel reads git credentials; shared variant does not", async () => {
  const meta = { _slug: "cli-probe-admin", adminMode: true, allowNetwork: true, allowedMcps: [] };
  const home = os.homedir();
  const gitconfig = sandboxPath(path.join(home, ".gitconfig"));

  const admin = await buildSettings(meta, { allowBypass: true });
  assert.ok(admin.sandbox.filesystem.allowRead.includes(gitconfig));

  const shared = await buildSettings(meta);
  assert.ok(!shared.sandbox.filesystem.allowRead.includes(gitconfig));
});

test("catalog credential paths are write-denied in writable folders", async () => {
  const s = await buildSettings({ _slug: "cli-probe-tamper", allowBash: true, allowNetwork: true, allowedMcps: [] });
  const home = os.homedir();
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    for (const rel of entry.credentialHomePaths) {
      const p = sandboxPath(path.join(home, rel));
      assert.ok(s.sandbox.filesystem.denyWrite.includes(p), `${id}: ${p} must be write-denied`);
    }
  }
});

test("normalizeRequestedDomain accepts what humans paste, refuses what the sandbox must", () => {
  assert.equal(normalizeRequestedDomain("api.example.com"), "api.example.com");
  assert.equal(normalizeRequestedDomain("https://api.example.com/v1/deploy?x=1"), "api.example.com");
  assert.equal(normalizeRequestedDomain("Example.COM/path"), "example.com");
  assert.equal(normalizeRequestedDomain("example.com:8080"), "example.com");
  assert.equal(normalizeRequestedDomain("*.example.dev"), "*.example.dev");
  for (const bad of ["*", "localhost", "127.0.0.1", "https://127.0.0.1/x", "single-label", ""]) {
    assert.throws(() => normalizeRequestedDomain(bad), undefined, bad);
  }
});

test("channel extraNetworkDomains join that channel's sandbox list; malformed values degrade to none", async () => {
  const meta = { _slug: "extra-probe", allowBash: true, allowNetwork: true, allowedMcps: [], extraNetworkDomains: ["api.example.com"] };
  const s = await buildSettings(meta);
  assert.ok(s.sandbox.network.allowedDomains.includes("api.example.com"));

  const other = await buildSettings({ _slug: "extra-probe-2", allowBash: true, allowNetwork: true, allowedMcps: [] });
  assert.ok(!other.sandbox.network.allowedDomains.includes("api.example.com"));

  // READ/SPAWN path — tolerant on purpose. A hand-edited config must degrade to "no extras" rather
  // than break every run startup, so one malformed entry drops the whole list here.
  assert.deepEqual(normalizeStoredDomains(["api.ok.com", "not a domain !!"]), []);
  assert.deepEqual(normalizeStoredDomains("api.ok.com"), []);
  const broken = await buildSettings({ ...meta, _slug: "extra-probe-3", extraNetworkDomains: ["good.example.com", "b a d"] });
  assert.ok(!broken.sandbox.network.allowedDomains.includes("good.example.com"));
});

// The tolerant form above is the wrong contract for a SAVE. The admin channel routes used it on the
// write path too, so a single typo in one entry silently discarded every previously approved domain
// and answered "ok" — the operator only found out when runs started failing to reach a host they
// could swear was allowed. Writes use the strict form and surface the error instead.
test("the write path is strict: one bad entry rejects the save rather than wiping the list", () => {
  assert.deepEqual(
    normalizeNetworkDomains(["good.example.com", "api.ok.com"], { allowEmpty: true }),
    ["good.example.com", "api.ok.com"],
  );
  // Deliberately clearing the list is still allowed on a save…
  assert.deepEqual(normalizeNetworkDomains([], { allowEmpty: true }), []);
  // …but destroying it by accident is not.
  assert.throws(
    () => normalizeNetworkDomains(["good.example.com", "b a d"], { allowEmpty: true }),
    /b a d/,
    "the offending value is named so the 400 can quote it",
  );
  assert.throws(() => normalizeNetworkDomains("api.ok.com", { allowEmpty: true }), /must be an array/);
  assert.throws(() => normalizeNetworkDomains(["*"], { allowEmpty: true }), /not allowed/);
});
