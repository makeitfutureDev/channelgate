// The live proof of the durability contract, against a REAL podman/docker and the real channel
// image. Opt-in: `npm run test:live-container` (CG_LIVE_CONTAINER=1). Skipped — never failed — in
// the normal suite, on a machine with no container CLI, and when the image is not built.
//
// The unit tests pin the argv and the Containerfile; this one pins the OUTCOME, which is the thing
// an operator actually asked about: install a CLI, drop files in HOME, /tmp and /var/tmp, then put
// the container through everything the gateway routinely does to it — the idle reaper's stop, a
// restart, and the recreate an image bump or a config change triggers — and find all of it still
// there afterwards.
//
// It works on a throwaway channel slug of its own (`cg-durability-<random>`) inside the test
// scratch root, so it can never touch a real channel's container or volume, and it removes both at
// the end with the one legitimate `destroy(target, { volumes: true })` in the codebase.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto",
  image: process.env.CG_LIVE_IMAGE || "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};

const HOME_MARKER = "/home/agent/.config/durability/marker";
const TMP_MARKER = "/tmp/cg-durability-marker";
const VAR_TMP_MARKER = "/var/tmp/cg-durability-marker";
const FAKE_CLI = "/home/agent/.local/bin/cg-fake-cli";

const LIVE = process.env.CG_LIVE_CONTAINER === "1";
let skip = LIVE ? false : "opt-in — run `npm run test:live-container` (needs podman/docker + a built image)";
let runtime = null;

const { __setContainerRuntime, __resetContainerRuntime, bootContainerRuntime, stopContainerRuntime, containerBackend } =
  await import("../src/runtimes/container/index.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");

if (LIVE) {
  runtime = __setContainerRuntime({ log: () => {} });
  const boot = await bootContainerRuntime({ settings: SETTINGS, log: () => {} });
  stopContainerRuntime(); // this test drives the lifecycle by hand; no background sweep
  if (!boot.cli?.ok) skip = `no usable container CLI: ${boot.cli?.reason || "unknown"}`;
  else if (!boot.image?.present) skip = boot.image?.reason || "the channel image is not built";
}

test("live: a channel keeps its HOME, its installed CLIs and both temp trees across a stop, a restart and a recreate", { skip, timeout: 180_000 }, async () => {
  const slug = `cg-durability-${randomBytes(4).toString("hex")}`;
  const target = resolveRuntime(slug, { platform: "slack", channelId: "C-DURABILITY", runtime: "container" }, { settings: SETTINGS });
  const name = target.container.name;

  // Every command runs as the image's own user, with the image's own environment — the same way a
  // hand-attached `podman exec` (and every engine spawn) sees the container.
  const sh = async (script, { expect = 0 } = {}) => {
    const result = await runtime.exec.runExec(target, [name, "sh", "-c", script], { retry: false, timeoutMs: 60_000 });
    if (expect !== null) {
      assert.equal(result.code, expect, `\`${script}\` exited ${result.code}: ${String(result.stderr || result.stdout).trim()}`);
    }
    return { code: result.code, out: String(result.stdout || "").trim(), err: String(result.stderr || "").trim() };
  };
  // One marker per line: the markers are written without a trailing newline, so a bare `cat` of
  // all three would run them together into one word.
  const readMarkers = () => sh([HOME_MARKER, TMP_MARKER, VAR_TMP_MARKER].map((f) => `cat ${f}; echo`).join("; "), { expect: null });

  try {
    // ── First run: create it, then accumulate everything a channel accumulates ────────────────
    const first = await containerBackend.ensureUp(target, {});
    assert.equal(first.created, true, "the throwaway channel had no container yet");

    await sh([
      "set -e",
      `mkdir -p "$(dirname ${HOME_MARKER})" "$(dirname ${FAKE_CLI})"`,
      `printf home > ${HOME_MARKER}`,
      `printf tmp > ${TMP_MARKER}`,
      `printf vartmp > ${VAR_TMP_MARKER}`,
      `printf '#!/bin/sh\\necho cg-fake-cli-ok\\n' > ${FAKE_CLI}`,
      `chmod +x ${FAKE_CLI}`,
    ].join("\n"));

    // An install is only real if the shell can FIND it: ~/.local/bin has to be on the image PATH.
    const resolved = await sh("command -v cg-fake-cli");
    assert.equal(
      resolved.out,
      FAKE_CLI,
      "cg-fake-cli did not resolve on PATH — the running image predates the wider PATH; rebuild with `npm run build:image`",
    );
    assert.equal((await sh("cg-fake-cli")).out, "cg-fake-cli-ok");
    assert.deepEqual((await readMarkers()).out.split("\n"), ["home", "tmp", "vartmp"]);

    // ── The idle reaper's stop, then the next turn's start ────────────────────────────────────
    // This is the exact pair that used to empty /tmp and /var/tmp, ten minutes after every turn.
    await runtime.lifecycle.stopContainer(name, { settings: SETTINGS, reason: "durability test" });
    const restarted = await containerBackend.ensureUp(target, {});
    assert.deepEqual(
      { created: restarted.created, started: restarted.started },
      { created: false, started: true },
      "an exited container must be STARTED, never recreated",
    );
    assert.deepEqual((await readMarkers()).out.split("\n"), ["home", "tmp", "vartmp"], "a stop must not empty /tmp or /var/tmp");
    assert.equal((await sh("cg-fake-cli")).out, "cg-fake-cli-ok", "an installed CLI must survive a stop");

    // ── A recreate: what an image bump or a settings change does ──────────────────────────────
    const idBefore = await runtime.cli.runWith(runtime.cli.peek(), ["inspect", "--type", "container", "--format", "{{.Id}}", name], { timeoutMs: 30_000 });
    target.container.network = target.container.network === "none" ? "bridge" : "none"; // create-time-immutable → a new fingerprint
    const recreated = await containerBackend.ensureUp(target, {});
    assert.equal(recreated.created, true, "a changed fingerprint must produce a NEW container");
    const idAfter = await runtime.cli.runWith(runtime.cli.peek(), ["inspect", "--type", "container", "--format", "{{.Id}}", name], { timeoutMs: 30_000 });
    assert.notEqual(String(idAfter.stdout).trim(), String(idBefore.stdout).trim(), "the container was not actually replaced");

    const mounted = await runtime.cli.runWith(
      runtime.cli.peek(),
      ["inspect", "--type", "container", "--format", "{{range .Mounts}}{{.Name}}{{.Source}} {{end}}", name],
      { timeoutMs: 30_000 },
    );
    assert.match(String(mounted.stdout), new RegExp(target.container.homeVolume.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the recreated container must reuse the SAME HOME volume");
    assert.deepEqual((await readMarkers()).out.split("\n"), ["home", "tmp", "vartmp"], "a recreate must keep HOME, /tmp and /var/tmp");
    assert.equal((await sh("cg-fake-cli")).out, "cg-fake-cli-ok", "an installed CLI must survive a recreate");
  } finally {
    // The one legitimate `volumes: true` in the whole codebase: this channel is a throwaway.
    await containerBackend.destroy(target, { volumes: true, reason: "durability test cleanup" }).catch(() => {});
    stopContainerRuntime();
    __resetContainerRuntime();
  }
});
