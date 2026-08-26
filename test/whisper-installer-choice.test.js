import { test } from "node:test";
import assert from "node:assert/strict";

let installer = null;
try {
  installer = await import("../scripts/configure-whisper.mjs");
} catch {
  // RED: the installer-choice module does not exist yet.
}

test("installer flags and environment select Whisper deterministically", () => {
  assert.equal(typeof installer?.parseWhisperChoice, "function");
  assert.equal(installer.parseWhisperChoice({ args: ["--with-whisper"] }), true);
  assert.equal(installer.parseWhisperChoice({ args: ["--without-whisper"] }), false);
  assert.equal(installer.parseWhisperChoice({ env: { CG_INSTALL_WHISPER: "yes" } }), true);
  assert.equal(installer.parseWhisperChoice({ env: { CG_INSTALL_WHISPER: "0" } }), false);
  assert.equal(installer.parseWhisperChoice(), null);
  assert.throws(() => installer.parseWhisperChoice({ args: ["--with-whisper", "--without-whisper"] }), /both/i);
});

test("prompt answers default to enabled and recognize explicit no", () => {
  assert.equal(typeof installer?.parsePromptAnswer, "function");
  assert.equal(installer.parsePromptAnswer("", true), true);
  assert.equal(installer.parsePromptAnswer("no", true), false);
  assert.equal(installer.parsePromptAnswer("Y", false), true);
  assert.equal(installer.parsePromptAnswer("wat", true), null);
});

test("disabled setup persists false and never provisions Whisper", async () => {
  assert.equal(typeof installer?.runWhisperSetup, "function");
  const saved = [];
  let provisions = 0;
  const enabled = await installer.runWhisperSetup({
    args: ["--without-whisper"],
    save: (patch) => saved.push(patch),
    provision: async () => { provisions += 1; },
    write: () => {},
  });
  assert.equal(enabled, false);
  assert.deepEqual(saved, [{ whisperEnabled: false }]);
  assert.equal(provisions, 0);
});

test("noninteractive setup keeps the existing effective default", async () => {
  assert.equal(typeof installer?.runWhisperSetup, "function");
  const saved = [];
  let provisions = 0;
  const enabled = await installer.runWhisperSetup({
    interactive: false,
    currentEnabled: true,
    save: (patch) => saved.push(patch),
    provision: async () => { provisions += 1; },
    write: () => {},
  });
  assert.equal(enabled, true);
  assert.deepEqual(saved, [{ whisperEnabled: true }]);
  assert.equal(provisions, 1);
});
