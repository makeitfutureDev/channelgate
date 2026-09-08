import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { tempDir } from "./helpers.js";
import { launchUpdate } from "../scripts/update-launcher.mjs";

test("invalid launch environments leave the existing environment untouched and never invoke a runner", async () => {
  for (const value of [null, [], {}, { CHANNELGATE_DIR: "/test", CG_UPDATE_OWNER_TOKEN: false }, { CHANNELGATE_DIR: "/test", CG_UPDATE_OWNER_TOKEN: "token", OTHER: 1 }]) {
    const env = { HOME: "/original" };
    await assert.rejects(launchUpdate({ input: Readable.from([JSON.stringify(value)]), env, run: () => assert.fail("invalid environment reached runner") }), /invalid/);
    assert.deepEqual(env, { HOME: "/original" });
  }
});

test("launcher CLI rejects malformed credential payloads without logging their contents", () => {
  const root = tempDir("cg-update-launcher-secret-");
  const file = path.join(root, "output.log");
  const fd = openSync(file, "w", 0o600);
  let result;
  try {
    result = spawnSync(process.execPath, [new URL("../scripts/update-launcher.mjs", import.meta.url).pathname], {
      input: '{"CG_UPDATE_OWNER_TOKEN":"fixture-secret-must-not-appear",BROKEN}',
      stdio: ["pipe", fd, fd], timeout: 5_000,
    });
  } finally { closeSync(fd); }
  assert.equal(result.status, 1);
  const output = readFileSync(file, "utf8");
  assert.match(output, /Update service could not load its launch environment/);
  assert.doesNotMatch(output, /fixture-secret-must-not-appear|CG_UPDATE_OWNER_TOKEN|BROKEN|SyntaxError/);
});
