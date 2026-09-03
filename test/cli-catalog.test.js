// The CLI catalog (src/config/cli-catalog.js) after the Linux + containers-only cut (2026-09-03):
// it is reference data for the `/secrets` name suggestions in the Slack modal and the channel
// env API. Nothing links a host login into a run and there is no per-gateway switch any more.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { CLI_INTEGRATIONS, cliEnvKeys, cliIntegrationIds, normalizeCliIntegrations } = await import("../src/config/cli-catalog.js");

test("every catalog entry has a label, bare lowercase domains and HOME-relative credential paths", () => {
  assert.ok(Object.keys(CLI_INTEGRATIONS).length > 0);
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    assert.ok(entry.label, id);
    assert.ok(Array.isArray(entry.domains) && entry.domains.length > 0, `${id}: domains`);
    for (const domain of entry.domains) assert.match(domain, /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${id}: ${domain} must be a bare lowercase hostname`);
    assert.ok(Array.isArray(entry.envKeys) && entry.envKeys.length > 0, `${id}: envKeys`);
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

test("the /secrets suggestions cover every catalog env name", () => {
  const suggested = cliEnvKeys(cliIntegrationIds());
  for (const entry of Object.values(CLI_INTEGRATIONS)) for (const key of entry.envKeys) assert.ok(suggested.includes(key), key);
  assert.ok(suggested.includes("SUPABASE_ACCESS_TOKEN") && suggested.includes("VERCEL_TOKEN") && suggested.includes("MAKE_API_TOKEN"));
  assert.equal(new Set(suggested).size, suggested.length, "no duplicate suggestions");
});
