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
      defaultToken: "org-token",
    }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "channel-token", source: "channel" },
    }
  );
});

test("Composio shared identity falls back to the organization without replacing the user", () => {
  assert.deepEqual(
    resolveComposioConnections({ userToken: "user-token", defaultToken: "org-token" }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "org-token", source: "org" },
    }
  );
});

test("Composio no-default mode keeps personal and channel tokens but blocks the organization", () => {
  assert.deepEqual(
    resolveComposioConnections({ userToken: "user-token", defaultToken: "org-token", noOrg: true }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "", source: "none-no-org-default" },
    }
  );

  assert.equal(
    resolveComposioConnections({ channelToken: "channel-token", defaultToken: "org-token", noOrg: true }).shared.token,
    "channel-token"
  );
});

test("clean mode removes both Composio identities", () => {
  assert.deepEqual(
    resolveComposioConnections({
      clean: true,
      userToken: "user-token",
      channelToken: "channel-token",
      defaultToken: "org-token",
    }),
    {
      user: { token: "", source: "clean" },
      shared: { token: "", source: "clean" },
    }
  );
});

test("a DM gets only the personal identity — no channel token, no organization fallback", () => {
  assert.deepEqual(
    resolveComposioConnections({
      userToken: "user-token",
      channelToken: "channel-token",
      defaultToken: "org-token",
      isDM: true,
    }),
    {
      user: { token: "user-token", source: "user" },
      shared: { token: "", source: "none-dm" },
    }
  );

  assert.deepEqual(
    resolveComposioConnections({ defaultToken: "org-token", isDM: true }),
    {
      user: { token: "", source: "none" },
      shared: { token: "", source: "none-dm" },
    }
  );
});
