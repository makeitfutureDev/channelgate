import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [
  { CLI_INTEGRATIONS, GIT_TOOLING_HOME_PATHS, normalizeCliIntegrations, cliNetworkDomains, cliCredentialHomePaths, publicCliCatalog },
  { saveSettings, getCliIntegrations, getEffectiveNetworkDomains, getNetworkDomains, getCredentialHomePaths },
  { buildSettings },
  { normalizeNetworkDomains, normalizeRequestedDomain, normalizeStoredDomains },
] = await Promise.all([
  import("../src/config/cli-catalog.js"),
  import("../src/config/settings.js"),
  import("../src/gateway/folders.js"),
  import("../src/util/network-domains.js"),
]);

const sandboxPath = (p) => `/${p.replace(/^\/+/, "")}`;

test("every catalog entry ships domains that pass the shared normalizer", () => {
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    // A catalog domain that fails normalization would silently vanish from an engine allow-list.
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

test("settings getters merge enabled integrations without touching the base list", () => {
  saveSettings({ cliIntegrations: ["vercel", "bogus"], networkDomains: [] });
  assert.deepEqual(getCliIntegrations(), ["vercel"]);
  const effective = getEffectiveNetworkDomains();
  for (const d of getNetworkDomains()) assert.ok(effective.includes(d), d);
  for (const d of cliNetworkDomains(["vercel"])) assert.ok(effective.includes(d), d);
  // The stored/base list the UI round-trips must NOT absorb the integration domains.
  assert.ok(!getNetworkDomains().includes("api.vercel.com"));
  const creds = getCredentialHomePaths();
  for (const p of GIT_TOOLING_HOME_PATHS) assert.ok(creds.includes(p), p);
  for (const p of cliCredentialHomePaths(["vercel"])) assert.ok(creds.includes(p), p);

  saveSettings({ cliIntegrations: [] });
  assert.deepEqual(getCliIntegrations(), []);
  assert.ok(!getEffectiveNetworkDomains().includes("api.vercel.com"));
  assert.deepEqual(getCredentialHomePaths(), GIT_TOOLING_HOME_PATHS);
});

test("bash+network sandbox gains integration domains and read-only credential paths", async () => {
  saveSettings({ cliIntegrations: ["vercel", "supabase"] });
  const s = await buildSettings({ _slug: "cli-probe", allowBash: true, allowNetwork: true, allowedMcps: [] });
  for (const d of cliNetworkDomains(["vercel", "supabase"])) assert.ok(s.sandbox.network.allowedDomains.includes(d), d);
  const home = os.homedir();
  for (const rel of cliCredentialHomePaths(["vercel", "supabase"])) {
    const p = sandboxPath(path.join(home, rel));
    assert.ok(s.sandbox.filesystem.allowRead.includes(p), p);
    assert.ok(!(s.sandbox.filesystem.allowWrite || []).includes(p), `${p} must never be writable`);
  }
});

test("network-off channels get no integration carve-outs at all", async () => {
  saveSettings({ cliIntegrations: ["vercel"] });
  const s = await buildSettings({ _slug: "cli-probe-off", allowBash: true, allowNetwork: false, allowedMcps: [] });
  assert.equal(s.sandbox.network, undefined);
  const home = os.homedir();
  for (const rel of cliCredentialHomePaths(["vercel"])) {
    assert.ok(!s.sandbox.filesystem.allowRead.includes(sandboxPath(path.join(home, rel))));
  }
});

test("disabled integrations leave the sandbox exactly on the git/gh baseline", async () => {
  saveSettings({ cliIntegrations: [] });
  const s = await buildSettings({ _slug: "cli-probe-base", allowBash: true, allowNetwork: true, allowedMcps: [] });
  const home = os.homedir();
  for (const rel of GIT_TOOLING_HOME_PATHS) {
    assert.ok(s.sandbox.filesystem.allowRead.includes(sandboxPath(path.join(home, rel))), rel);
  }
  assert.ok(!s.sandbox.network.allowedDomains.includes("api.vercel.com"));
  for (const rel of cliCredentialHomePaths(["vercel"])) {
    assert.ok(!s.sandbox.filesystem.allowRead.includes(sandboxPath(path.join(home, rel))));
  }
});

// The gap found in an ops channel: an admin-mode channel with Bash OFF is the most
// privileged run yet was the only network-on mode that could never read the git credentials.
// The ADMIN-RUN variant (allowBypass) now gets the credential re-allows; the shared settings
// file for the same channel must NOT (non-admin authors keep the narrow contract).
test("admin-run variant of a no-bash network channel reads credentials; shared variant does not", async () => {
  saveSettings({ cliIntegrations: [] });
  const meta = { _slug: "cli-probe-admin", adminMode: true, allowNetwork: true, allowedMcps: [] };
  const home = os.homedir();
  const gitconfig = sandboxPath(path.join(home, ".gitconfig"));

  const admin = await buildSettings(meta, { allowBypass: true });
  assert.ok(admin.sandbox.filesystem.allowRead.includes(gitconfig));

  const shared = await buildSettings(meta);
  assert.ok(!shared.sandbox.filesystem.allowRead.includes(gitconfig));
});

test("catalog credential paths are write-denied in writable folders even when DISABLED", async () => {
  saveSettings({ cliIntegrations: [] });
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
  saveSettings({ cliIntegrations: [] });
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

test("public catalog exposes render metadata and the API surface round-trips ids", () => {
  const catalog = publicCliCatalog();
  assert.ok(catalog.length >= 3);
  for (const entry of catalog) {
    assert.ok(entry.id && entry.label && Array.isArray(entry.domains));
  }
  assert.ok(catalog.some((e) => e.id === "vercel"));
  assert.ok(catalog.some((e) => e.id === "supabase"));
  assert.ok(catalog.some((e) => e.id === "make"));
});
