import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSIO_INVENTORY_ACTION_ID, COMPOSIO_INVENTORY_PAGE_SIZE,
  composioInventoryBlocks, normalizeComposioInventoryPage,
} from "../src/slack/composio-inventory-view.js";

const account = (id, extra = {}) => ({ app: "gmail", id, alias: `mail-${id}`, account: `${id}@example.test`, status: "ACTIVE", ...extra });
const ready = (accounts, extra = {}) => ({ mode: "personal", source: "user", state: "ready", accounts, ...extra });
const buttons = (blocks) => blocks.flatMap((block) => [block.accessory, ...(block.elements || [])].filter((element) => element?.type === "button"));
const rows = (blocks) => blocks.filter((block) => block.type === "section" && block.text.type === "plain_text").map((block) => block.text.text);
const text = (blocks) => blocks.flatMap((block) => [block.text?.text, ...(block.elements || []).map((element) => element.text)]).filter(Boolean).join("\n");

test("inventory renders applications, aliases, owner identities, status, defaults, types and identity fallback", () => {
  const blocks = composioInventoryBlocks(ready([
    account("first", { isDefault: true, accountType: "oauth" }),
    account("second", { status: "EXPIRED" }),
    account("id-only", { app: "slack", alias: "", account: "" }),
  ]));
  assert.match(text(blocks), /2 applications · 3 accounts/);
  assert.match(text(blocks), /Personal connections/);
  assert.match(rows(blocks)[0], /gmail — mail-first · first@example\.test\nACTIVE · Default · oauth/);
  assert.match(rows(blocks)[1], /EXPIRED/);
  assert.match(rows(blocks)[2], /slack — id-only/);
  assert.match(text(blocks), /may omit inactive or unpublished/);
  assert.deepEqual(buttons(blocks).map((button) => JSON.parse(button.value)), [{ o: "composio_refresh" }]);
});

test("loading, empty, partial, unavailable and unconfigured states remain honest and refreshable", () => {
  for (const [inventory, expected] of [
    [undefined, /Loading connections/],
    [ready([]), /reported no connected accounts/],
    [ready([account("known")], { state: "partial" }), /list is incomplete/],
    [ready([], { state: "unavailable", message: "Provider temporarily unavailable" }), /Provider temporarily unavailable/],
    [ready([], { state: "unconfigured", source: "none" }), /No Composio connection is configured/],
  ]) {
    const blocks = composioInventoryBlocks(inventory);
    assert.match(text(blocks), expected);
    assert.equal(buttons(blocks)[0].text.text, "Refresh");
    assert.equal(buttons(blocks)[0].action_id, COMPOSIO_INVENTORY_ACTION_ID);
  }
  assert.equal(rows(composioInventoryBlocks(ready([account("known")], { state: "partial" }))).length, 1);
});

test("source labels distinguish personal, channel, organization, SDK and direct-message identities", () => {
  for (const [source, label] of [
    ["user", "Personal connections"], ["channel", "Channel connections"], ["org", "Organization connections"],
    ["sdk-user", "Personal connections · organization Composio SDK"],
    ["sdk-channel", "Channel connections · organization Composio SDK"],
    ["none-dm", "Direct message · personal connections only"], ["none-no-org-default", "Organization fallback disabled"],
  ]) assert.match(text(composioInventoryBlocks(ready([], { source }))), new RegExp(label));
  assert.doesNotMatch(text(composioInventoryBlocks(ready([], { mode: "sdk" }))), /may omit/);
});

test("seventy accounts remain reachable through native pagination without dropping rows", () => {
  const accounts = Array.from({ length: 70 }, (_, index) => account(String(index)));
  const visited = [];
  let page = 0;
  for (;;) {
    const blocks = composioInventoryBlocks(ready(accounts), { page });
    const accountRows = rows(blocks);
    assert.ok(accountRows.length <= COMPOSIO_INVENTORY_PAGE_SIZE);
    assert.ok(blocks.length <= 10, "bounded modal space on mobile");
    visited.push(...accountRows.map((row) => row.match(/mail-(\d+)/)[1]));
    const previous = buttons(blocks).find((button) => button.text.text === "Previous accounts");
    assert.equal(Boolean(previous), page > 0);
    if (previous) assert.equal(JSON.parse(previous.value).page, page - 1);
    const next = buttons(blocks).find((button) => button.text.text === "Next accounts");
    if (!next) break;
    assert.equal(JSON.parse(next.value).o, "composio_page");
    const nextPage = JSON.parse(next.value).page;
    assert.equal(nextPage, page + 1);
    page = nextPage;
  }
  assert.deepEqual(visited, accounts.map((entry) => entry.id));
  assert.match(text(composioInventoryBlocks(ready(accounts), { page })), /Accounts 67–70 of 70 · Page 12 of 12/);
});

test("arbitrary provider text stays inert and all Block Kit text and button limits hold", () => {
  const malicious = "<!channel> <@U123> <https://example.test|click> *bold* `code` & <b>HTML</b>";
  const blocks = composioInventoryBlocks(ready([
    account("unsafe", { app: malicious, alias: malicious, account: malicious, status: malicious, accountType: malicious }),
    account("large", { app: "a".repeat(5000), alias: "b".repeat(5000), account: "c".repeat(5000), status: "s".repeat(5000), accountType: "t".repeat(5000) }),
  ], { source: malicious, state: "partial", message: malicious.repeat(100) }));
  assert.match(rows(blocks)[0], /<!channel>/, "raw label remains readable as plain text");
  for (const block of blocks) {
    if (block.text) {
      assert.ok(block.text.text.length <= 3000);
      if (block.text.type === "mrkdwn") assert.doesNotMatch(block.text.text, /<!channel>|<@U123>|https:\/\//);
    }
    for (const element of block.elements || []) {
      if (element.type === "plain_text") assert.ok(element.text.length <= 2000);
      assert.notEqual(element.type, "mrkdwn");
    }
  }
  for (const button of buttons(blocks)) assert.ok(button.text.text.length <= 75);
});

test("page normalization clamps stale and forged page requests and passes scoped commands unchanged", () => {
  for (const page of [undefined, NaN, Infinity, -Infinity, {}, [], null, -100, "invalid"]) {
    assert.equal(normalizeComposioInventoryPage(page, 70), 0);
  }
  assert.equal(normalizeComposioInventoryPage(999, 70), 11);
  assert.equal(normalizeComposioInventoryPage("2", 70), 2);
  assert.equal(normalizeComposioInventoryPage(2.9, 70), 2);
  assert.equal(normalizeComposioInventoryPage(3, 0), 0);
  const calls = [];
  const blocks = composioInventoryBlocks(ready(Array.from({ length: 14 }, (_, i) => account(String(i)))), {
    page: 1, command(operation, extra = {}) { calls.push({ operation, extra }); return JSON.stringify({ o: operation, c: "channel", ...extra }); },
  });
  assert.deepEqual(calls, [
    { operation: "composio_refresh", extra: {} },
    { operation: "composio_page", extra: { page: 0 } },
    { operation: "composio_page", extra: { page: 2 } },
  ]);
  for (const button of buttons(blocks)) assert.equal(JSON.parse(button.value).c, "channel");
});
