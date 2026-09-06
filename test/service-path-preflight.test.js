import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";
import { privateServiceAncestor } from "../scripts/service-path-preflight.mjs";

test("a new service identity refuses private home ancestors before checkout ownership changes", () => {
  const root = tempDir("cg-service-path-");
  chmodSync(root, 0o711);
  const home = path.join(root, "operator-home");
  const code = path.join(home, "Code");
  mkdirSync(code, { recursive: true, mode: 0o755 });
  for (const mode of [0o700, 0o750]) {
    chmodSync(home, mode);
    assert.equal(privateServiceAncestor(code), home);
  }
  chmodSync(home, 0o711);
  assert.equal(privateServiceAncestor(code), "");
  chmodSync(home, 0o700);
  const alias = path.join(root, "alias");
  symlinkSync(code, alias);
  assert.equal(privateServiceAncestor(alias), home, "a symlink cannot hide a private ancestor");
});
