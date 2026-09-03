import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { platformArtifact, safeArchiveEntries } from "../scripts/install-whisper.mjs";

test("selects pinned official Linux assets and refuses every other platform", () => {
  assert.deepEqual(platformArtifact({ platform: "linux", arch: "x64" }), {
    name: "whisper-bin-ubuntu-x64.tar.gz",
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
  });
  assert.deepEqual(platformArtifact({ platform: "linux", arch: "arm64" }), {
    name: "whisper-bin-ubuntu-arm64.tar.gz",
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
  });
  assert.throws(() => platformArtifact({ platform: "darwin", arch: "arm64" }), /Linux only/);
  assert.throws(() => platformArtifact({ platform: "linux", arch: "riscv64" }), /unsupported/i);
});

test("archive validation rejects traversal and absolute entries", () => {
  assert.equal(safeArchiveEntries(["whisper/bin", "whisper/lib.so"]), true);
  assert.throws(() => safeArchiveEntries(["../escape"]), /unsafe/i);
  assert.throws(() => safeArchiveEntries(["/tmp/escape"]), /unsafe/i);
});

test("setup offers an explicit Whisper choice and update honors the stored setting", () => {
  const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
  const update = readFileSync(new URL("../scripts/update.sh", import.meta.url), "utf8");
  const provision = readFileSync(new URL("../scripts/update-provision.sh", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(install, /node scripts\/configure-whisper\.mjs/);
  assert.match(install, /--with-whisper/);
  assert.match(install, /--without-whisper/);
  assert.match(update, /update-runner\.mjs/);
  assert.match(provision, /read_setting whisperEnabled/);
  assert.match(provision, /Local Whisper disabled.*skipping/i);
  assert.match(provision, /node scripts\/install-whisper\.mjs/);
  assert.equal(pkg.scripts["whisper:install"], "node scripts/install-whisper.mjs");
});
