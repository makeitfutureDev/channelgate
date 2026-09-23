// The guide must teach an admin turn how to FIND reclaimable container storage, and must not turn
// that into a licence to delete. Container storage grows unattended — nothing in the gateway
// reclaims images, and the idle reaper stops containers without removing them — so an agent that
// never looks lets a host fill up, and an agent that tidies up on its own can destroy a channel's
// engine sessions and CLI logins in a single `podman volume prune`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { applyGatewayGuide } = await import("../src/gateway/guide.js");
const guidePath = (cwd, rel) => path.join(cwd, ".claude/skills/gateway-usage", rel);

test("every platform's materialized guide routes housekeeping to the admin reference", async () => {
  const cwd = tempDir("cg-housekeeping-guide-");
  try {
    for (const platform of ["slack", "msteams", "googlechat"]) {
      await applyGatewayGuide(cwd, { platform });
      const skill = await readFile(guidePath(cwd, "SKILL.md"), "utf8");
      assert.match(skill, /Check disk space, stale containers or old runtime images/, platform);
      assert.match(skill, /never delete on your own/, platform);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("the housekeeping guidance is diagnosis-first and forbids autonomous deletion", async () => {
  const admin = await readFile(new URL("../src/gateway/gateway-usage/references/administration.md", import.meta.url), "utf8");
  assert.match(admin, /## Disk space, stale containers and old images \(admin\)/);
  // The standing instruction the user asked for: manual or scheduled, never automatic.
  assert.match(admin, /\*\*Never delete anything automatically\.\*\*/);
  assert.match(admin, /only on an explicit request or from a schedule an admin set up/);
  assert.match(admin, /Report what you found and what it would free/);
});

test("it names the checks, and the two traps that make a naive cleanup wrong", async () => {
  const admin = await readFile(new URL("../src/gateway/gateway-usage/references/administration.md", import.meta.url), "utf8");
  // How to look.
  assert.match(admin, /df -h \//);
  assert.match(admin, /podman system df -v/);
  // Trap 1: tags move, so a container's TAG lies about which image it pins. Comparing tags instead
  // of image IDs makes every stale container look current and hides the real space.
  assert.match(admin, /Do not compare tags/);
  assert.match(admin, /the tag moved, while the container still holds the older image ID/);
  // Trap 2: a removed container's named HOME volume becomes dangling, so a blanket volume prune
  // destroys live channel state. This is the irreversible one.
  assert.match(admin, /`podman volume prune` is not safe/);
  assert.match(admin, /destroys\s+that channel's engine sessions, CLI logins and installed tools/);
  // Why leftovers exist at all: test runs pin their own scratch runtime root.
  assert.match(admin, /cg-<runtime-root-hash>-<platform>-<slug>/);
  assert.match(admin, /each run pins\s+its own scratch runtime root/);
});

test("it refuses to retire a running container and tells the reader where to run the commands", async () => {
  const admin = await readFile(new URL("../src/gateway/gateway-usage/references/administration.md", import.meta.url), "utf8");
  assert.match(admin, /Never remove a container that is `Up`/);
  assert.match(admin, /holding a lease\s+for a background job, a schedule or an attached editor/);
  // There is no podman inside a channel container; without this the agent reports a false negative.
  assert.match(admin, /there is no `podman` inside a channel\s+container/);
  assert.match(admin, /admin `\/sudo` thread/);
});

test("the guide sends the agent to the gateway's own report first, and to --apply only on request", async () => {
  const admin = await readFile(new URL("../src/gateway/gateway-usage/references/administration.md", import.meta.url), "utf8");
  assert.match(admin, /npm run runtime:storage\s+# report only/);
  assert.match(admin, /Only if they ask, run `npm run runtime:storage -- --apply`/);
  assert.match(admin, /schedule `--apply` only when they say so/);
});
