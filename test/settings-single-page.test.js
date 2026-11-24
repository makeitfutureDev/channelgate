// Matcher rules and stable entry points. The full browsing, search and Save flow runs
// in settings-navigation-browser.test.js against a disposable admin API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeText, searchTerms, rankSettings } from "../public/admin-settings-search.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("each settings deep link has one named category in a navigation group", () => {
  const sections = [...html.matchAll(/<section class="setsec"[^>]+>/g)].map(([tag]) => {
    const section = /data-sec="([^"]+)"/.exec(tag)[1];
    assert.ok(tag.includes(`id="set-${section}"`));
    assert.ok(tag.includes(`aria-labelledby="set-${section}-h"`));
    assert.match(tag, /data-group="[^"]+"/);
    assert.ok(html.includes(`<h3 id="set-${section}-h">`));
    return section;
  });
  assert.equal(sections.length, new Set(sections).size);
  // Old URLs are also used by Activity, provider setup, and admin identity enrollment.
  for (const key of ["connection", "appearance", "agent", "engine-licenses", "calls", "messaging", "integrations", "license", "access", "admin-access", "system"]) {
    assert.ok(sections.includes(key), `#set-${key} is still addressable`);
  }
});

test("chat setup is collapsed and optional feature cards point to their own activation control", () => {
  const connection = html.split('id="set-connection"')[1].split("</section>")[0];
  const setup = [...connection.matchAll(/<details([^>]*)>\s*<summary><h4>([^<]+)<\/h4>/g)];
  assert.equal(setup.length, 3);
  for (const [, attributes] of setup) assert.doesNotMatch(attributes, /\bopen\b/);
  const features = [...html.matchAll(/<article([^>]*data-feature-toggle="[^"]+"[^>]*)>([\s\S]*?)<\/article>/g)];
  assert.ok(features.length >= 7);
  for (const [, attributes, body] of features) {
    const id = /data-feature-toggle="([^"]+)"/.exec(attributes)[1];
    assert.match(body, new RegExp(`<input(?=[^>]*id="${id}")(?=[^>]*type="checkbox")[^>]*>`), id);
  }
});

test("query normalization accepts ordinary keyboard input for typographic labels", () => {
  assert.deepEqual(searchTerms("Slack   slack  TOKEN"), ["slack", "token"]);
  assert.deepEqual(searchTerms("   "), []);
  assert.equal(normalizeText("public URL"), normalizeText("public URL"));
  assert.equal(normalizeText("Daemon’s"), normalizeText("Daemon's"));
});

test("ranks exact field names above text mentions and accepts terms from the category path", () => {
  const signing = { title: "Signing secret", path: "Workspace / Chat connections / Slack", keywords: "slackSigningSecret" };
  const guide = { title: "Slack setup", text: "Copy the signing secret from your app.", isCard: true, path: "Workspace / Chat connections" };
  const unrelated = { title: "Message events", path: "Workspace / Chat connections / Slack" };
  const entries = [guide, unrelated, signing];
  assert.deepEqual(rankSettings(entries, "signing-secret"), [signing, guide]);
  assert.deepEqual(rankSettings(entries, "slack secret"), [signing, guide]);
  assert.deepEqual(rankSettings(entries, "connections"), [guide], "a category-only hit lists cards without flooding the results with fields");
  assert.deepEqual(rankSettings(entries, "workspace never-matches"), []);
  assert.deepEqual(rankSettings(entries, ""), []);
});
