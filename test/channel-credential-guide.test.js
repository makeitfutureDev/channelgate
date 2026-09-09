import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { applyGatewayGuide } = await import("../src/gateway/guide.js");
const guidePath = (cwd, rel) => path.join(cwd, ".claude/skills/gateway-usage", rel);

test("materialized guides expose credential discovery without relaxing identity or runtime policy", async () => {
  const cwd = tempDir("cg-credential-guide-");
  try {
    for (const platform of ["slack", "msteams", "googlechat"]) {
      await applyGatewayGuide(cwd, { platform });
      const skill = await readFile(guidePath(cwd, "SKILL.md"), "utf8");
      const admin = await readFile(guidePath(cwd, "references/administration.md"), "utf8");
      assert.match(skill, /Channel credentials for THIS attempt/);
      assert.match(skill, /current names or explicit empty result override earlier turns/);
      assert.match(skill, /Clean runs omit this inventory/);
      assert.match(skill, /before reporting missing access or asking for another connection/);
      assert.match(skill, /Never silently switch accounts or substitute/);
      assert.match(skill, /reads and searches may use either or both/);
      assert.match(skill, /unless the user restricts the account or scope; writes require the intended account/);
      assert.match(skill, /Credential availability does not grant tool permissions, network access/);
      assert.match(admin, /not written to the project's `\.env`/);
      assert.match(admin, /some consume an environment variable\s+automatically; others require an explicit option or request header/);
      assert.match(admin, /Never run a full environment dump/);
      assert.doesNotMatch(admin, /You cannot read them and neither can anyone else|without being told to/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("the guide's presence-check example reveals only a boolean for present and absent credentials", async () => {
  const admin = await readFile(new URL("../src/gateway/gateway-usage/references/administration.md", import.meta.url), "utf8");
  const example = /```sh\nnode -e '([^']+)'\n```/.exec(admin);
  assert.ok(example, "the administration guide must contain an executable presence-check example");
  const fakeCredential = "synthetic-guide-fixture-do-not-display";
  for (const [env, expected] of [
    [{ HUBSPOT_ACCESS_TOKEN: fakeCredential }, "HUBSPOT_ACCESS_TOKEN present: true\n"],
    [{}, "HUBSPOT_ACCESS_TOKEN present: false\n"],
  ]) {
    const result = spawnSync(process.execPath, ["-e", example[1]], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(fakeCredential));
  }
});
