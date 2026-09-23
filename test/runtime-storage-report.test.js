// The storage report's policy (src/runtimes/container/storage-report.js) and the command around it
// (scripts/runtime-storage.mjs). The command only ever REPORTS unless given --apply; these pin down
// what it would remove, because the one irreversible mistake — a channel's HOME volume — destroys
// that channel's engine sessions, CLI logins and installed tools.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyStorage, reclaimableImageSpace, REMOVE, KEEP } from "../src/runtimes/container/storage-report.js";

const ME = "3b50564c";
const CURRENT = "aaaa0000current";
const OLD = "bbbb1111old";
const LIVE_PATHS = new Set(["/home/me/ChannelGate/.runtime/slack/a", "/home/other/ChannelGate/.runtime/slack/x"]);
const sourceExists = (p) => LIVE_PATHS.has(p);

const container = (over) => ({ id: over.name, labeled: true, running: false, status: "exited", imageId: CURRENT, install: ME, mounts: [], ...over });
const byName = (rows, name) => rows.find((r) => r.name === name);

test("this gateway's containers: running is never touched; stopped on a superseded image is; stopped on the current image is kept", () => {
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [
      container({ name: "cg-3b50564c-slack-busy", running: true, status: "running", imageId: OLD }),
      container({ name: "cg-3b50564c-slack-old", imageId: OLD }),
      container({ name: "cg-3b50564c-slack-fresh" }),
    ],
  });
  assert.equal(byName(r.containers, "cg-3b50564c-slack-busy").action, KEEP, "a running container may hold a lease — even on an old image");
  assert.equal(byName(r.containers, "cg-3b50564c-slack-old").action, REMOVE);
  assert.match(byName(r.containers, "cg-3b50564c-slack-old").reason, /recreated on the current image.*HOME volume is kept/);
  assert.equal(byName(r.containers, "cg-3b50564c-slack-fresh").action, KEEP, "restarts in under a second — nothing to gain");
});

test("the incident: dead test roots are removed even while `Up`; a second live gateway sharing the store is never touched", () => {
  const leftovers = Array.from({ length: 84 }, (_, k) => container({
    name: `cg-e2bec723-slack-fixture-${k}`, install: "e2bec723", running: true, status: "running", imageId: OLD,
    mounts: [{ type: "bind", source: `/tmp/cg-test-${k}/ChannelGate/x` }, { type: "volume", volume: `cg-e2bec723-slack-fixture-${k}-home` }],
  }));
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [
      ...leftovers,
      container({ name: "cg-9f9f9f9f-slack-x", install: "9f9f9f9f", running: false, imageId: OLD, mounts: [{ type: "bind", source: "/home/other/ChannelGate/.runtime/slack/x" }] }),
    ],
    volumes: [...leftovers.map((c) => ({ name: `${c.name}-home` })), { name: "cg-9f9f9f9f-slack-x-home" }],
  });
  assert.equal(r.removable.containers.filter((c) => c.install === "e2bec723").length, 84, "every orphaned test container is reclaimable");
  assert.match(r.removable.containers[0].reason, /mounted folders no longer exist.*still running `sleep infinity`/);
  const other = byName(r.containers, "cg-9f9f9f9f-slack-x");
  assert.equal(other.action, KEEP, "its folders exist — possibly a live gateway under this account");
  assert.match(other.reason, /never touched/);
  assert.equal(r.removable.volumes.length, 84, "the dead install's volumes go with it");
  assert.equal(r.volumes.find((v) => v.name === "cg-9f9f9f9f-slack-x-home").action, KEEP, "another install's volume stays when that install may be alive");
});

test("a foreign container with only SOME folders gone is kept — only a fully dead install is orphaned", () => {
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [container({ name: "cg-12345678-slack-half", install: "12345678", mounts: [
      { type: "bind", source: "/gone/for/good" },
      { type: "bind", source: "/home/other/ChannelGate/.runtime/slack/x" },
    ] })],
  });
  assert.equal(r.containers[0].action, KEEP);
});

test("a channel's HOME volume is never removed — not even when its container is being removed", () => {
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [container({ name: "cg-3b50564c-slack-old", imageId: OLD, mounts: [{ type: "volume", volume: "cg-3b50564c-slack-old-home" }] })],
    volumes: [{ name: "cg-3b50564c-slack-old-home" }, { name: "cg-3b50564c-slack-long-gone-home" }],
  });
  assert.equal(r.containers[0].action, REMOVE, "precondition — its container goes");
  for (const v of r.volumes) {
    assert.equal(v.action, KEEP, `${v.name} is kept`);
    assert.match(v.reason, /channel HOME — never removed by this tool/);
  }
});

test("volumes: attached ones stay, anonymous unused ones go, unknown names are out of scope", () => {
  const anon = "f".repeat(64);
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [container({ name: "cg-3b50564c-slack-fresh", mounts: [{ type: "volume", volume: "cg-3b50564c-slack-fresh-home" }, { type: "volume", volume: "a".repeat(64) }] })],
    volumes: [{ name: "cg-3b50564c-slack-fresh-home" }, { name: "a".repeat(64) }, { name: anon }, { name: "postgres-data" }],
  });
  assert.equal(r.volumes.find((v) => v.name === "a".repeat(64)).action, KEEP, "an anonymous volume a kept container uses stays");
  assert.equal(r.volumes.find((v) => v.name === anon).action, REMOVE);
  assert.equal(r.volumes.find((v) => v.name === "postgres-data").action, KEEP);
  assert.match(r.volumes.find((v) => v.name === "postgres-data").reason, /outside this report's scope/);
});

test("images: current, rollback and in-use images stay; older unused runtime images and untagged leftovers go; others are out of scope", () => {
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, sourceExists,
    containers: [container({ name: "cg-3b50564c-slack-pins", running: true, imageId: "cccc2222pinned" })],
    images: [
      { id: CURRENT, tags: ["localhost/channelgate/runtime:latest", "localhost/channelgate/runtime:1.5.0"], size: 5e9, spec: "1.5.0" },
      { id: "dddd3333prev", tags: ["localhost/channelgate/runtime:1.4.0"], size: 4e9, spec: "1.4.0" },
      { id: "eeee4444older", tags: ["localhost/channelgate/runtime:1.3.0"], size: 4e9, spec: "1.3.0" },
      { id: "ffff5555oldest", tags: ["localhost/channelgate/runtime:1.2.1"], size: 3e9, spec: "1.2.1" },
      { id: "cccc2222pinned", tags: ["localhost/channelgate/runtime:1.1.0"], size: 1.5e9, spec: "1.1.0" },
      { id: "9999dangling", tags: [], size: 2e8, spec: "" },
      { id: "8888node", tags: ["docker.io/library/node:22"], size: 3e8, spec: "" },
    ],
  });
  const action = (id) => r.images.find((i) => i.id === id).action;
  assert.equal(action(CURRENT), KEEP);
  assert.equal(action("dddd3333prev"), KEEP, "the newest older spec is the rollback image");
  assert.equal(action("eeee4444older"), REMOVE);
  assert.equal(action("ffff5555oldest"), REMOVE);
  assert.equal(action("cccc2222pinned"), KEEP, "an old image a running container still uses cannot go");
  assert.equal(action("9999dangling"), REMOVE);
  assert.equal(action("8888node"), KEEP, "not ours to judge");
  assert.equal(r.images.find((i) => i.id === "dddd3333prev").reason, "spec 1.4.0, kept as the rollback image");

  const none = classifyStorage({ installId: ME, currentImageId: CURRENT, keepPreviousSpecs: 0, images: [
    { id: CURRENT, tags: ["channelgate/runtime:latest"], spec: "1.5.0" },
    { id: "dddd3333prev", tags: ["channelgate/runtime:1.4.0"], spec: "1.4.0" },
  ] });
  assert.equal(none.images.find((i) => i.id === "dddd3333prev").action, REMOVE, "--keep-previous 0 keeps no rollback image");
});

test("an image a REMOVED container used becomes reclaimable, one a kept container uses does not", () => {
  const r = classifyStorage({
    installId: ME, currentImageId: CURRENT, keepPreviousSpecs: 0, sourceExists,
    containers: [container({ name: "cg-3b50564c-slack-old", imageId: OLD })],
    images: [
      { id: CURRENT, tags: ["channelgate/runtime:latest"], spec: "1.5.0" },
      { id: OLD, tags: ["channelgate/runtime:1.3.0"], spec: "1.3.0" },
    ],
  });
  assert.equal(r.images.find((i) => i.id === OLD).action, REMOVE, "its only user is being removed");
});

test("reclaimable space is counted layer by layer — neither summed sizes nor per-image unique sizes", () => {
  // current: base + A + CUR.  old 1.4.0: base + A + B.  old 1.3.0: base + B + C.
  // Removing both old images frees only B and C: base and A stay with the current image, and B is
  // shared by the two removed images (so podman's per-image "unique" size counts it for neither).
  const rows = [
    { id: "cur", action: KEEP, size: 700, layers: [{ digest: "base", size: 500 }, { digest: "A", size: 100 }, { digest: "CUR", size: 100 }] },
    { id: "o14", action: REMOVE, size: 700, layers: [{ digest: "base", size: 500 }, { digest: "A", size: 100 }, { digest: "B", size: 100 }] },
    { id: "o13", action: REMOVE, size: 650, layers: [{ digest: "base", size: 500 }, { digest: "B", size: 100 }, { digest: "C", size: 50 }] },
  ];
  assert.deepEqual(reclaimableImageSpace(rows), { reclaimableImageBytes: 150, reclaimableImagePrecision: "exact" });
  // Summed sizes would claim 1350; unique sizes would claim 50 (C only).
  const noLayers = rows.map(({ layers, ...rest }) => rest);
  assert.deepEqual(reclaimableImageSpace(noLayers), { reclaimableImageBytes: 1350, reclaimableImagePrecision: "upper-bound" }, "without layer data it says it is an upper bound");
});

test("the command reports by default and removes only with --apply", () => {
  const script = readFileSync(new URL("../scripts/runtime-storage.mjs", import.meta.url), "utf8");
  assert.match(script, /const out = \{ apply: false/, "report is the default");
  assert.match(script, /if \(options\.apply\) \{[\s\S]*applyReport\(bin, report\)/, "removal happens only under --apply");
  assert.equal((script.match(/applyReport\(/g) || []).length, 2, "defined once, called once");
  assert.match(script, /Nothing was changed/);
  // Top-level images only: `images -a` lists intermediate layers at their full virtual size.
  assert.match(script, /\["images", "-q", "--no-trunc"\]/);
  assert.doesNotMatch(script, /"images", "-aq"/);
  // Containers go with `rm -v`, which drops only ANONYMOUS volumes; a named HOME volume survives.
  assert.match(script, /\["rm", "-f", "-v", c\.id\]/);
  assert.doesNotMatch(script, /volume", "prune"|system", "prune"|image", "prune"/, "never a blanket prune");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["runtime:storage"], "node scripts/runtime-storage.mjs");
});
