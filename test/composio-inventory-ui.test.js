import test from "node:test";
import assert from "node:assert/strict";
import { composioInventoryMarkup, mountComposioInventory } from "../public/admin-composio.js";

const ready = (accounts = [], extra = {}) => ({
  state: "ready", source: "user", mode: "personal", message: "Reported by provider", accounts, ...extra,
});

// Model the DOM property relevant to switching records: replacing innerHTML creates new child
// nodes. An old request may finish, but its retained child must no longer be the visible node.
function rootFixture() {
  const root = {};
  Object.defineProperty(root, "innerHTML", { set(value) {
    this.markup = value;
    this.button = { disabled: false, addEventListener(_event, fn) { this.click = fn; } };
    this.output = { innerHTML: "", textContent: "" };
  } });
  root.querySelector = (selector) => selector === ".composio-refresh" ? root.button : root.output;
  return root;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("inventory shows every account across applications, including default and disabled accounts", () => {
  const markup = composioInventoryMarkup(ready([
    { app: "gmail", id: "ca-work", alias: "Work", account: "work@example.test", status: "ACTIVE", isDefault: true },
    { app: "gmail", id: "ca-personal", account: "personal@example.test", status: "DISABLED", accountType: "PERSONAL" },
    { app: "slack", id: "ca-team", alias: "Team", status: "ACTIVE" },
  ]));
  for (const label of ["2 apps · 3 accounts", "Work", "work@example.test", "personal@example.test", "Team", "ca-work", "DISABLED", "PERSONAL", "default"]) {
    assert.ok(markup.includes(label), `renders ${label}`);
  }
  assert.equal((markup.match(/<tr>/g) || []).length, 4, "one header and all three account rows");
});

test("provider labels, identities, statuses and messages are escaped in HTML", () => {
  const payload = '<img src=x onerror="alert(1)">&\'malicious';
  const markup = composioInventoryMarkup(ready([
    { app: payload, id: payload, alias: payload, account: payload, status: payload, accountType: payload },
  ], { message: payload, source: payload }));
  assert.doesNotMatch(markup, /<img|onerror="|<script/);
  assert.ok(markup.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;malicious"));
  assert.match(markup, /Composio connections/, "unknown provider source cannot inject markup");
});

test("confirmed empty inventory differs from unavailable, unconfigured and partial results", () => {
  assert.match(composioInventoryMarkup(ready()), /No accounts reported/);
  for (const state of ["unavailable", "unconfigured", "partial"]) {
    const markup = composioInventoryMarkup(ready([], { state, message: `${state} explanation` }));
    assert.match(markup, new RegExp(`${state} explanation`));
    assert.doesNotMatch(markup, /No accounts reported/, `${state} is not a confirmed empty account list`);
  }
  const partial = composioInventoryMarkup(ready([{ app: "gmail", id: "ca-one" }], { state: "partial", message: "Some applications could not be loaded" }));
  assert.match(partial, /Some applications could not be loaded/);
  assert.match(partial, /ca-one/);
});

test("source attribution distinguishes personal, channel, organization defaults and direct messages", () => {
  for (const [source, label] of [
    ["user", "Personal connections · composio-user"],
    ["channel", "Channel connections · composio-agent"],
    ["org", "Organization default · composio-agent"],
    ["sdk-user", "Personal connections · composio-user · SDK"],
    ["sdk-channel", "Channel connections · composio-agent · SDK"],
    ["none-dm", "Direct message · personal connections only"],
  ]) assert.ok(composioInventoryMarkup(ready([], { source })).includes(label));
});

test("loading is lazy when requested and concurrent opens do not duplicate provider calls", async () => {
  const root = rootFixture(), pending = deferred(), calls = [];
  const load = mountComposioInventory(root, "/api/users/U_A/composio-connections", {
    autoLoad: false, request: (url) => { calls.push(url); return pending.promise; },
  });
  assert.deepEqual(calls, []);
  assert.match(root.markup, /aria-live="polite"/);
  const running = load();
  assert.equal(root.button.disabled, true);
  assert.match(root.output.textContent, /Loading/);
  await load();
  assert.equal(calls.length, 1);
  pending.resolve(ready());
  await running;
  assert.equal(root.button.disabled, false);
  await load();
  assert.equal(calls.length, 1, "reopening already loaded section reuses its result");
});

test("saving configuration during a lookup queues a fresh request and discards the previous identity's response", async () => {
  const root = rootFixture(), previous = deferred(), current = deferred(), calls = [];
  const load = mountComposioInventory(root, "/api/channels/C_A/composio-connections", {
    autoLoad: false, request: (url) => {
      calls.push(url);
      return calls.length === 1 ? previous.promise : current.promise;
    },
  });
  const running = load();
  await load(true);
  await load(true);
  assert.equal(calls.length, 1, "queued changes do not overlap provider lookups");
  previous.resolve(ready([{ app: "gmail", id: "ca-old-identity" }]));
  await running;
  assert.equal(calls.length, 2, "forced refresh survives the first request finishing");
  assert.equal(calls[1], "/api/channels/C_A/composio-connections?refresh=1");
  assert.doesNotMatch(root.output.innerHTML, /ca-old-identity/);
  assert.equal(root.button.disabled, true, "loading stays visible while the new lookup runs");
  current.resolve(ready([{ app: "slack", id: "ca-new-identity" }]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.output.innerHTML, /ca-new-identity/);
  assert.equal(root.button.disabled, false);
});

test("refresh bypasses the loaded guard and retries transport failures without displaying raw errors", async () => {
  const root = rootFixture(), calls = [];
  const load = mountComposioInventory(root, "/api/channels/C_A/composio-connections", {
    autoLoad: false, request: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error("PRIVATE_PROVIDER_CREDENTIAL");
      return ready([{ app: "gmail", id: "ca-recovered" }]);
    },
  });
  await load();
  assert.match(root.output.textContent, /Could not load/);
  assert.doesNotMatch(root.output.textContent, /PRIVATE_PROVIDER_CREDENTIAL/);
  assert.equal(root.button.disabled, false);
  await root.button.click();
  assert.match(root.output.innerHTML, /ca-recovered/);
  assert.deepEqual(calls, ["/api/channels/C_A/composio-connections", "/api/channels/C_A/composio-connections?refresh=1"]);
  await load(true);
  assert.equal(calls.length, 3);
});

test("switching selected records isolates a late response from the newly visible inventory", async () => {
  const root = rootFixture(), pending = deferred();
  const loadFirst = mountComposioInventory(root, "/api/users/U_FIRST/composio-connections", {
    autoLoad: false, request: () => pending.promise,
  });
  const first = loadFirst();
  const firstOutput = root.output;
  const loadSecond = mountComposioInventory(root, "/api/users/U_SECOND/composio-connections", {
    autoLoad: false, request: async () => ready([{ app: "gmail", id: "ca-second" }]),
  });
  await loadSecond();
  pending.resolve(ready([{ app: "slack", id: "ca-first-private" }]));
  await first;
  assert.notEqual(firstOutput, root.output);
  assert.match(root.output.innerHTML, /ca-second/);
  assert.doesNotMatch(root.output.innerHTML, /ca-first-private/);
});
