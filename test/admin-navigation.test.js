import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";
import {
  ADMIN_VIEW_PATHS,
  conversationKindForChannel,
  conversationRouteForPath,
  pathForConversation,
  pathForView,
  titleForView,
  viewForPath,
} from "../public/admin-routes.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;

const EXPECTED = {
  dashboard: "/overview",
  channels: "/conversations",
  users: "/users",
  schedules: "/automations",
  audit: "/activity",
  api: "/api-docs",
  settings: "/settings",
};

test("every admin view has a canonical path and round-trips from it", () => {
  assert.deepEqual(ADMIN_VIEW_PATHS, Object.values(EXPECTED));
  for (const [view, path] of Object.entries(EXPECTED)) {
    assert.equal(pathForView(view), path);
    assert.equal(viewForPath(path), view);
    assert.equal(viewForPath(`${path}/`), view);
    assert.ok(titleForView(view));
  }
  assert.equal(viewForPath("/"), "dashboard");
  assert.equal(viewForPath("/not-an-admin-page"), null);
});

test("admin navigation uses real links and browser history", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const [view, path] of Object.entries(EXPECTED)) {
    assert.match(html, new RegExp(`data-view="${view}" href="${path}"`));
  }
  assert.match(app, /history\.pushState/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /el\.href = conversationPathForKey\(key\)/);
  assert.match(app, /initialConversationRoute/);
});

test("MCP checklists load and persist separate catalogs for the effective engine", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(app, /AVAILABLE_MCPS\s*=\s*\{\s*claude:\s*null,\s*codex:\s*null\s*\}/);
  assert.match(app, /\/api\/mcp\/available\?engine=\$\{encodeURIComponent\(engine\)\}/);
  assert.match(app, /effectiveMcpEngine/);
  assert.match(app, /allowedCodexMcps/);
  assert.match(app, /captureMcpSelection/);
  assert.match(app, /renderMcpBoxForEngine/);
});

test("admin capability labels state the effective network boundary", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /approved-domain network/);
  assert.match(app, /\["claude", "codex"\]/);
  assert.match(app, /unrestricted network/);
  assert.match(app, /String\(m\.engine \|\| "claude"\)/);
});

test("channel, DM, and group detail paths round-trip to selection keys", () => {
  assert.equal(conversationKindForChannel({ type: "channel" }), "channel");
  assert.equal(conversationKindForChannel({ type: "group" }), "group");
  assert.equal(conversationKindForChannel({ type: "mpim" }), "group");
  assert.equal(conversationKindForChannel({ type: "im", isDM: true }), "dm");
  const cases = [
    ["channel", "C123", "ch:C123"],
    ["dm", "D456", "dm:D456"],
    ["group", "G789", "ch:G789"],
    ["group", "mpdm-A1.B2-3", "ch:mpdm-A1.B2-3"],
  ];
  for (const [kind, channelId, key] of cases) {
    const path = `/conversations/${kind}/${channelId}`;
    assert.equal(pathForConversation(kind, channelId), path);
    assert.deepEqual(conversationRouteForPath(path), { kind, channelId, key });
    assert.deepEqual(conversationRouteForPath(`${path}/`), { kind, channelId, key });
    assert.equal(viewForPath(path), "channels");
  }
  assert.equal(pathForConversation("unknown", "C123"), "/conversations");
  assert.equal(pathForConversation("channel", "bad/id"), "/conversations");
  assert.equal(conversationRouteForPath("/conversations/channel/bad/id"), null);
});

test("API docs preserve the verified Make Slack trigger requirements", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /slack:CreateMessage/);
  assert.match(html, /data-bot-user-id/, "the Make help names the connected bot's member ID dynamically");
  assert.doesNotMatch(html, /U0BAQFWHNAK|U05ABGR1NSC/, "no workspace-specific member IDs are baked into the product");
  assert.match(html, /A0X0JM3SB/);
  assert.match(html, /B059F7J9QR4/);
  assert.match(html, /ifempty\(62\.thread_ts; 62\.ts\)/);
  assert.match(html, /Both the gateway bot and the Make app must be members/);
});

const { createWebApp } = await import("../src/web/app.js");
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("direct visits and refreshes serve the admin shell at every page path", async () => {
  const paths = [...ADMIN_VIEW_PATHS, "/conversations/channel/C123", "/conversations/dm/D456", "/conversations/group/G789"];
  for (const path of paths) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(response.headers.get("cache-control") || "", /no-cache/);
    assert.match(await response.text(), /id="view-dashboard"/);
  }
});

test("unknown paths still return 404 instead of silently opening Overview", async () => {
  for (const path of ["/not-an-admin-page", "/conversations/unknown/C123", "/conversations/channel/bad/id"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
  }
});
