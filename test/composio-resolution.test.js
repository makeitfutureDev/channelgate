import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { resolveComposioConnections } = await import("../src/gateway/run.js");

test("Composio resolution keeps the active user separate from the channel identity", () => {
  assert.deepEqual(
    resolveComposioConnections({
      userToken: "user-token",
      channelToken: "channel-token",
    }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "channel-token", source: "channel" },
    }
  );
});

test("there is no organization-default Composio: a keyless channel has no shared identity", () => {
  // A stale caller that still passes the retired org-default arguments cannot revive the fallback.
  assert.deepEqual(
    resolveComposioConnections({ userToken: "user-token", defaultToken: "org-token", noOrg: false }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "", source: "none" },
    }
  );
  assert.equal(resolveComposioConnections({ channelToken: "channel-token" }).shared.token, "channel-token");
});

test("the organization-default Composio token and the channel opt-out are retired fields", async () => {
  const { DEAD_RECORD_FIELDS, stripDeadSettings, stripDeadFields } = await import("../src/config/dead-fields.js");
  assert.ok(DEAD_RECORD_FIELDS.includes("noDefaultTokens"));
  assert.deepEqual(stripDeadFields({ composioToken: "c", noDefaultTokens: true }), { composioToken: "c" });
  assert.deepEqual(
    stripDeadSettings({ composioMode: "personal", defaultComposioToken: "org", defaultComposioTokenLabel: "owner" }),
    { composioMode: "personal" },
  );
  const settings = await import("../src/config/settings.js");
  assert.equal(typeof settings.getDefaultComposioToken, "undefined");
  const { revealableFields, readSecret } = await import("../src/web/secrets.js");
  assert.ok(!revealableFields("settings").includes("defaultComposioToken"));
  await assert.rejects(readSecret({ scope: "settings", field: "defaultComposioToken" }), /not revealable/);
});

test("clean mode removes both Composio identities", () => {
  assert.deepEqual(
    resolveComposioConnections({
      clean: true,
      userToken: "user-token",
      channelToken: "channel-token",
    }),
    {
      user: { token: "", source: "clean" },
      shared: { token: "", source: "clean" },
    }
  );
});

test("a DM gets only the personal identity — no channel token", () => {
  assert.deepEqual(
    resolveComposioConnections({
      userToken: "user-token",
      channelToken: "channel-token",
      isDM: true,
    }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "", source: "none-dm" },
    }
  );

  assert.deepEqual(
    resolveComposioConnections({ isDM: true }),
    {
      user: { token: "", source: "none" },
      shared: { token: "", source: "none-dm" },
    }
  );
});
