// Runtime-gate entry point. This module deliberately has NO static imports: ESM hoists and
// evaluates a static import graph BEFORE any statement runs, so a version check inside
// src/server.js can never fire first — on an old runtime, node:sqlite (require of a missing
// builtin) explodes with a stack trace instead of a friendly message. Checking here and only
// then dynamically importing the real server guarantees the gate runs before any src module
// (and any builtin that may not exist everywhere) is touched.
//
// engines.node is advisory (npm only warns) and `git pull` + restart never re-runs install.sh's
// check, so this is the only gate a live deploy actually hits.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`ChannelGate requires Node >= 22.13 (node:sqlite); running on ${process.versions.node}. Upgrade Node and restart.`);
  process.exit(1);
}

// Linux only (systemd + rootless Podman). The check lives in a dependency-free module so it stays
// unit-testable without booting the server; importing it touches nothing but that one file.
const { platformRefusal } = await import("./platform-gate.js");
const refusal = platformRefusal(process.platform);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

await import("./server.js");
