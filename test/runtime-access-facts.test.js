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

test("shared SSH identity is explained from resolved mounts without exposing the rest of the gateway", () => {
  const source = path.join(gatewayRoot(), "config", "agent-ssh");
  const t = target([{ ...bind(source, "/home/agent/.ssh/channelgate", "agent-ssh"), mode: "ro" }]);
  for (const clean of [false, true]) {
    const note = runtimeAccessPreamble(t, { clean, allowNetwork: false });
    assert.match(note, /Shared outbound SSH identity/);
    assert.match(note, /\/home\/agent\/\.ssh\/channelgate\/id_ed25519\.pub/);
    assert.match(note, /same key in every channel/);
    assert.match(note, /Do not generate a channel-specific replacement/);
    assert.match(note, /mounted read-only/);
    assert.match(note, /runtime directory: \*\*not mounted\*\*/);
    assert.match(note, /database: \*\*not mounted\*\*/);
    assert.ok(!note.includes(source), "only the in-container key path is disclosed");
  }
  assert.doesNotMatch(runtimeAccessPreamble(target([])), /Shared outbound SSH identity/);
  assert.match(runtimeAccessPreamble({ backend: "host" }), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  assert.match(note, /Network policy for this attempt is unknown/);
  assert.match(note, /Admin permission bypass for THIS attempt: \*\*unknown\*\*/);
  assert.doesNotMatch(note, /runtime directory: \*\*(not )?mounted\*\*/);
});

test("permission facts use the supplied launch decision, never channel mode or mounted home", () => {
  const home = target([bind(path.dirname(gatewayRoot()), undefined, "operator-home")]);
  home.meta = { adminMode: true, autoMode: true };
  for (const dangerouslySkip of [false, true]) {
    const note = runtimeAccessPreamble(home, { dangerouslySkip });
    assert.match(note, new RegExp(`Admin permission bypass for THIS attempt: \\*\\*${dangerouslySkip ? "enabled" : "disabled"}\\*\\*`));
    assert.match(note, /danger-full-access.*approval_policy.*never.*do not establish.*admin bypass/);
  }
  assert.match(runtimeAccessPreamble(home), /Admin permission bypass for THIS attempt: \*\*unknown\*\*/);
});

test("a sudo-host target states that the container boundary is absent", () => {
  const note = runtimeAccessPreamble({ backend: "host", container: null }, { clean: false, allowNetwork: true });
  assert.match(note, /Direct host access.*enabled by `\/sudo`/s);
  assert.match(note, /There is no channel-container boundary/);
  assert.match(note, /runtime directory: \*\*directly accessible\*\*/);
  assert.match(note, /Only organization-admin messages are admitted/);
});

test("an enforced network note names the advisory-only setups without claiming one applies", () => {
  const enforced = { backend: "container", container: { mounts: [], egress: { active: true, network: "none" } } };
  for (const allowNetwork of [true, false]) {
    const note = runtimeAccessPreamble(enforced, { clean: false, allowNetwork });
    assert.match(note, /The switch is ENFORCED/);
    assert.match(note, /advisory, not enforced, only in three other setups, none of which applies to this attempt/);
    assert.match(note, /legacy open-bridge egress mode/);
    assert.match(note, /rawNetwork/);
    assert.match(note, /`\/sudo` direct-host thread/);
  }
  const bridge = runtimeAccessPreamble({ backend: "container", container: { mounts: [], egress: { active: false } } }, { allowNetwork: false });
  assert.doesNotMatch(bridge, /none of which applies to this attempt/);
  assert.match(bridge, /advisory, not container egress enforcement/);
});

test("an enforced network note says raw tunnels use the proxy and only while the switch is on", () => {
  const enforced = { backend: "container", container: { mounts: [], egress: { active: true, network: "none" } } };
  for (const allowNetwork of [true, false]) {
    const note = runtimeAccessPreamble(enforced, { clean: false, allowNetwork });
    assert.match(note, /Raw sockets \(ssh, database protocols\) go through the same proxy/);
    assert.match(note, /only while the switch is on/);
    assert.match(note, /while it is off they are refused like everything else/);
    assert.doesNotMatch(note, /Raw sockets \(ssh, database protocols\) work only to hosts an admin declared\./);
  }
});
