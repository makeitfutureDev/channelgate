// The Settings page is ONE long page: all sections stacked and always in the DOM, a sticky header
// with a search box + section jump links, and search that only hides cards. These tests pin the
// matching rules (pure module) and the markup/wiring contract the single global Save depends on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  activeSectionFor,
  cardHaystack,
  filterSettings,
  normalizeText,
  searchTerms,
} from "../public/admin-settings-search.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const SECTIONS = ["connection", "agent", "templates", "integrations", "license", "access", "system"];

// ── The pure matcher ─────────────────────────────────────────────────────────────
test("query normalization folds the typography the admin markup actually uses", () => {
  assert.equal(normalizeText("  Daemon’s   Public URL "), "daemon's public url");
  assert.equal(normalizeText("org—default"), "org-default");
  assert.deepEqual(searchTerms("Slack   slack  TOKEN"), ["slack", "token"]);
  assert.deepEqual(searchTerms("   "), []);
  assert.deepEqual(searchTerms(""), []);
});

test("a card is searched together with its section's title and description", () => {
  const card = { sectionTitle: "Access & security", sectionDesc: "Who may use the bot", title: "Trusted bot apps", text: "app IDs" };
  assert.match(cardHaystack(card), /access & security who may use the bot trusted bot apps app ids/);
});

const INDEX = [
  { id: "connection-0", section: "connection", sectionTitle: "Connection", sectionDesc: "Slack credentials", title: "Slack credentials (Socket Mode)", text: "Bot User OAuth Token xoxb App-Level Token" },
  { id: "connection-1", section: "connection", sectionTitle: "Connection", sectionDesc: "Slack credentials", title: "Public URL", text: "the daemon’s externally-reachable base URL" },
  { id: "integrations-0", section: "integrations", sectionTitle: "Integrations", sectionDesc: "Composio endpoints", title: "MCP server URLs", text: "Composio Skills Toolbox" },
  { id: "system-0", section: "system", sectionTitle: "System", sectionDesc: "danger zone", title: "Danger zone", text: "restart daemon disconnect slack" },
];

test("an empty query leaves the whole page visible and reports itself inactive", () => {
  const result = filterSettings(INDEX, "   ");
  assert.equal(result.active, false);
  assert.equal(result.empty, false);
  assert.equal(result.matched, INDEX.length);
  for (const entry of INDEX) assert.equal(result.cards.get(entry.id), true);
});

test("terms are AND-ed, case- and typography-insensitive", () => {
  const result = filterSettings(INDEX, "Daemon URL");
  assert.equal(result.active, true);
  assert.equal(result.cards.get("connection-1"), true);
  assert.equal(result.cards.get("connection-0"), false);
  assert.equal(result.cards.get("system-0"), false); // has "daemon", not "url"
  assert.equal(result.matched, 1);
  assert.equal(result.sections.get("connection"), 1);
  assert.equal(result.sections.get("system"), 0);
});

test("searching a section name keeps that whole section, and only it", () => {
  const result = filterSettings(INDEX, "connection");
  assert.equal(result.sections.get("connection"), 2);
  assert.equal(result.sections.get("integrations"), 0);
  assert.equal(result.sections.get("system"), 0);
});

test("a query nothing matches is reported as empty; an unindexed page never is", () => {
  assert.equal(filterSettings(INDEX, "kubernetes").empty, true);
  assert.equal(filterSettings([], "kubernetes").empty, false);
  assert.equal(filterSettings([], "").empty, false);
});

// ── Scroll-spy ───────────────────────────────────────────────────────────────────
const SPY = [
  { id: "connection", top: 0, visible: true },
  { id: "agent", top: 600, visible: true },
  { id: "system", top: 1400, visible: true },
];

test("scroll-spy marks the section the reader is actually in", () => {
  assert.equal(activeSectionFor(SPY, 0, 800, 2200), "connection");
  assert.equal(activeSectionFor(SPY, 599, 800, 2200), "connection");
  assert.equal(activeSectionFor(SPY, 601, 800, 2200), "agent");
  // Scrolled to the very bottom the last section wins even when it is too short to reach the line.
  assert.equal(activeSectionFor(SPY, 1400, 800, 2200), "system");
});

test("scroll-spy skips sections a search has filtered out", () => {
  const filtered = [
    { id: "connection", top: 0, visible: false },
    { id: "agent", top: 0, visible: true },
    { id: "system", top: 300, visible: false },
  ];
  assert.equal(activeSectionFor(filtered, 0, 800, 900), "agent");
  assert.equal(activeSectionFor([], 0, 800, 900), null);
});

// ── The real page: markup contract ───────────────────────────────────────────────
test("every settings section is stacked on one page with an id, a heading and a jump link", () => {
  assert.match(html, /<div class="setpage">/);
  assert.match(html, /<div class="setbody" id="settings-body">/);
  for (const sec of SECTIONS) {
    assert.match(html, new RegExp(`<section class="setsec" id="set-${sec}" data-sec="${sec}"`), sec);
    assert.match(html, new RegExp(`<h3 id="set-${sec}-h">`), sec);
    assert.match(html, new RegExp(`<a href="#set-${sec}"[^>]*data-sec="${sec}"`), sec);
  }
  // Nothing may hide a pane any more — the old one-pane-at-a-time nav is gone.
  assert.doesNotMatch(html, /class="setsec active"/);
  assert.doesNotMatch(css, /\.setsec\.active/);
  assert.match(html, /<div class="setlayout">/);
});

test("the sticky header carries only search and section jumps live in a left rail", () => {
  assert.match(html, /<div class="setbar" id="settings-bar">/);
  assert.match(html, /<input id="settings-search" type="search"/);
  assert.match(html, /id="settings-search-clear"/);
  assert.match(html, /id="settings-no-results"/);
  const bar = html.slice(html.indexOf('<div class="setbar" id="settings-bar">'), html.indexOf('<div class="setlayout">'));
  assert.doesNotMatch(bar, /id="settings-nav"/);
  assert.match(html, /<div class="setlayout">\s*<!--[^]*?--?>\s*<nav class="setnav" id="settings-nav"/);
  assert.match(css, /\.setbar \{[^}]*position: sticky/);
  assert.match(css, /\.setlayout \{[^}]*grid-template-columns: 168px minmax\(0, 640px\)/);
  assert.match(css, /\.setnav \{[^}]*position: sticky[^}]*flex-direction: column/);
  assert.match(css, /\.setbody \.filtered-out \{ display: none; \}/);
});

test("search filters and jump links are wired, and never dirty the save bar", () => {
  assert.match(app, /import \{ activeSectionFor, filterSettings \} from "\.\/admin-settings-search\.js";/);
  assert.match(app, /search\.addEventListener\("input", \(\) => \{\n\s+const result = applySettingsFilter\(search\.value\);/);
  assert.match(app, /function buildSettingsIndex\(\)/);
  assert.match(app, /updateSettingsSpy\(\)/);
  // The search box lives in .setbar; typing in it must not flip Settings to "Unsaved changes".
  assert.match(app, /\.settings-savebar, \.checks-filter, \.setbar/);
  // Jumping is scrolling now, not pane swapping.
  assert.match(app, /function selectSettingsSection\(sec, \{ smooth = true/);
  assert.match(app, /scroller\.scrollTo\(\{ top: Math\.max\(0, top\)/);
  assert.doesNotMatch(app, /classList\.toggle\("active", p\.dataset\.sec === sec\)/);
});

// ── The real page: end-to-end index ──────────────────────────────────────────────
// Build the same kind of index app.js builds (section title + description + per-card text) straight
// out of index.html, so a card that gets renamed or moved can't quietly become unsearchable.
function indexFromHtml() {
  const body = html.slice(html.indexOf('<div class="setbody" id="settings-body">'), html.indexOf('<div class="savebar settings-savebar">'));
  const strip = (chunk) =>
    chunk
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&rsquo;/g, "’")
      .replace(/&lt;|&gt;|&quot;|&#39;|&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const index = [];
  for (const match of body.matchAll(/<section class="setsec" id="set-([a-z-]+)"[\s\S]*?(?=<section class="setsec"|$)/g)) {
    const [chunk, section] = [match[0], match[1]];
    const sectionTitle = strip(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk)?.[1] || "");
    const sectionDesc = strip(/<p class="setsec-desc">([\s\S]*?)<\/p>/.exec(chunk)?.[1] || "");
    const cards = chunk.split('<div class="setcard').slice(1);
    cards.forEach((card, i) => {
      index.push({
        id: `${section}-${i}`,
        section,
        sectionTitle,
        sectionDesc,
        title: strip(/<h4[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1] || ""),
        text: strip(card),
      });
    });
  }
  return index;
}

test("real settings text is searchable: representative queries land in the right sections", () => {
  const index = indexFromHtml();
  assert.ok(index.length >= 20, `expected the whole page to index, got ${index.length} cards`);
  assert.deepEqual([...new Set(index.map((entry) => entry.section))], SECTIONS);

  const sectionsFor = (query) => {
    const result = filterSettings(index, query);
    assert.equal(result.empty, false, `"${query}" matched nothing`);
    return [...result.sections].filter(([, hits]) => hits > 0).map(([section]) => section);
  };
  assert.ok(sectionsFor("xoxb").includes("connection"));
  assert.ok(sectionsFor("composio").includes("integrations"));
  assert.ok(sectionsFor("danger zone").includes("system"));
  assert.ok(sectionsFor("container runtime").includes("access"));
  assert.ok(sectionsFor("trusted bot apps").includes("access"));
  assert.ok(sectionsFor("license").includes("license"));
  assert.ok(sectionsFor("admin password").includes("system"));

  // Secrets are never part of the index: only the input's markup is, never a typed/stored value.
  assert.ok(!index.some((entry) => /xoxb-[a-z0-9]{6,}/i.test(entry.text)));
});
