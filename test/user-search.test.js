import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createUsersRouter, filterUsersForSearch } = await import("../src/web/routes/users.js");
const { setUser } = await import("../src/config/store.js");

const app = express();
app.use(createUsersRouter());
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

await setUser("U_SEARCH_ADMIN", {
  name: "Álvaro Admin",
  isAdmin: true,
  approved: false,
  composioToken: "composio-search-secret",
});
await setUser("U_SEARCH_APPROVED", {
  name: "Beta Builder",
  approved: true,
  toolboxToken: "toolbox-search-secret",
});
await setUser("U_SEARCH_NONE", { name: "Gamma Guest", approved: false });

async function search(query) {
  const response = await fetch(`${base}/users?q=${encodeURIComponent(query)}`);
  const body = await response.text();
  return { response, body, users: JSON.parse(body).users };
}

test("user search folds case and accents and ANDs multiple terms", async () => {
  assert.deepEqual(Object.keys((await search("alvaro ADMIN")).users), ["U_SEARCH_ADMIN"]);
  assert.deepEqual(Object.keys((await search("builder U_SEARCH_APPROVED")).users), ["U_SEARCH_APPROVED"]);
});

test("user search covers visible role and configured-token status", async () => {
  assert.deepEqual(Object.keys((await search("approved toolbox")).users), ["U_SEARCH_APPROVED"]);
  assert.deepEqual(Object.keys((await search("no access")).users), ["U_SEARCH_NONE"]);
  assert.deepEqual(Object.keys((await search("composio")).users), ["U_SEARCH_ADMIN"]);
  assert.deepEqual(Object.keys((await search("does-not-exist")).users), []);
});

test("search indexes the masked shape and never leaks a matching secret", async () => {
  const result = await search("search-secret");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.users, {});
  assert.equal(result.body.includes("composio-search-secret"), false);
  assert.equal(result.body.includes("toolbox-search-secret"), false);
  assert.equal(filterUsersForSearch(result.users, ""), result.users, "blank searches preserve the masked listing");
});

test("the Users page wires a debounced server search and clear control", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="users-search"[^>]*type="search"/);
  assert.match(html, /id="users-search-clear"/);
  assert.match(client, /api\(`\/api\/users\?q=\$\{encodeURIComponent\(query\)\}`\)/);
  assert.match(client, /setTimeout\(\(\) => loadUserResults\(\)[\s\S]*?, 220\)/);
  assert.match(client, /let USER_RESULTS = \{\};/);
});
