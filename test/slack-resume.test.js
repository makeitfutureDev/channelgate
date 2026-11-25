import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { sessionRuntimeStamp } = await import("../src/gateway/session-runtime.js");

test("the native /resume handler preserves shared history through its next turn", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", fileURLToPath(new URL("./fixtures/slack-resume-handler.mjs", import.meta.url))], {
    env: process.env, stdio: "pipe", encoding: "utf8", timeout: 30_000,
  });
});

test("adoption stamps follow both the target namespace and the adopted license", () => {
  const target = { backend: "container", runtimeScope: "admin", runtime: { fingerprint: () => "current-fingerprint" },
    container: { name: "current-container", image: "current-image", sharedHistory: true } };
  for (const engine of ["claude", "codex", "codex-eu"]) {
    const stamp = JSON.parse(sessionRuntimeStamp(target, engine));
    assert.equal(stamp.history, engine === "codex-eu" ? "" : "channel-v1");
    assert.equal(stamp.scope, "admin");
    assert.equal(stamp.fingerprint, "current-fingerprint");
  }
  target.container.sharedHistory = false;
  assert.equal(JSON.parse(sessionRuntimeStamp(target, "claude")).history, "");
  assert.equal(JSON.parse(sessionRuntimeStamp(null, "claude")).backend, "host");
  assert.equal(JSON.parse(sessionRuntimeStamp(null, "claude")).history, "");
});
