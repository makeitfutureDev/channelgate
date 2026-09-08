import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { gatewayRoot, dbFile } = await import("../src/config/paths.js");
const { gatewayStoreAccessNote, runtimeAccessPreamble } = await import("../src/gateway/runtime-access.js");
const bind = (source, target = source, kind = "workdir") => ({ type: "bind", kind, source, target });
const target = (mounts) => ({ container: { mounts }, settings: { fullAccessHome: true } });

test("container-local stores and parent scaffolding do not expose the host gateway store", () => {
  const root = gatewayRoot();
  const note = gatewayStoreAccessNote(target([
    bind(path.join(root, "clean-workspaces", "fixture")),
    bind(path.join(root, "socket"), "/opt/channelgate/control", "socket"),
    { type: "volume", kind: "home", source: "fixture-home", target: "/home/agent" },
  ]));
  assert.match(note, /runtime directory: \*\*not mounted\*\*/);
  assert.match(note, /database: \*\*not mounted\*\*/);
  assert.match(note, /Container-local \/opt\/channelgate and \/home\/agent/);
  assert.match(note, /parent directory scaffolding.*not evidence/);
  assert.ok(!note.includes(root), "an unmounted host path is not disclosed");
});

test("resolved parent grant and an explicitly selected gateway workdir expose the store", () => {
  for (const mount of [bind(path.dirname(gatewayRoot()), undefined, "operator-home"), bind(gatewayRoot())]) {
    const note = gatewayStoreAccessNote(target([mount]));
    assert.match(note, /runtime directory: \*\*mounted\*\*/);
    assert.match(note, /database: \*\*mounted\*\*/);
    assert.match(note, /still follows this attempt's tool permissions/);
  }
});

test("masks, sibling prefixes and database-only binds retain distinct access facts", () => {
  const root = gatewayRoot();
  const masked = gatewayStoreAccessNote(target([
    bind(path.dirname(root), undefined, "operator-home"),
    { kind: "mask", type: "tmpfs", source: "", target: root },
  ]));
  assert.match(masked, /runtime directory: \*\*not mounted\*\*/);
  assert.match(masked, /database: \*\*not mounted\*\*/);
  const sibling = gatewayStoreAccessNote(target([bind(root + "-sibling")]));
  assert.match(sibling, /runtime directory: \*\*not mounted\*\*/);
  const file = gatewayStoreAccessNote(target([{ type: "bind-file", kind: "fixture-file", source: dbFile(), target: "/fixture/database" }]));
  assert.match(file, /runtime directory: \*\*not mounted\*\*/);
  assert.match(file, /database: \*\*mounted\*\*/);
});

test("missing resolved facts stay unknown instead of inferring a mode or host isolation", () => {
  const note = runtimeAccessPreamble(undefined);
  assert.match(note, /database visibility are unknown/);
  assert.match(note, /Clean mode for this attempt is unknown/);
  assert.doesNotMatch(note, /runtime directory: \*\*(not )?mounted\*\*/);
});
