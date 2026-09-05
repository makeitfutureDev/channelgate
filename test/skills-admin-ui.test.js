import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const js = await readFile(new URL("../public/admin-skills.js", import.meta.url), "utf8");

test("Skills admin navigation separates sources, synchronization and MCP", () => {
  assert.match(html, /data-tab="sources"[^>]*>Sources/);
  assert.match(html, /data-tab="sync"[^>]*>Sync settings/);
  assert.match(html, /data-tab="mcp"[^>]*>MCP/);
  assert.match(js, /data-action="open-source"/);
  assert.match(js, /role="dialog"[^>]*aria-labelledby="add-source-title"/);
});

test("templates and usage expose searchable selection and understandable views", () => {
  assert.match(js, /id="template-select"/);
  assert.match(js, /id="template-skill-q"/);
  assert.doesNotMatch(js, /Explicit skills \(comma-separated slugs\)/);
  assert.match(js, /data-view="skill"/);
  assert.match(js, /data-view="channel"/);
  assert.match(js, /id="usage-q"/);
  assert.doesNotMatch(js, /Whole categories/);
  assert.doesNotMatch(js, /Assign a template to a conversation/);
  assert.match(js, /<th>Usage<\/th>/);
  assert.doesNotMatch(js, /<th>Exact<\/th>/);
  assert.match(js, /skill-discoverable/);
  assert.match(js, /skill-mandatory/);
  assert.match(js, /does not mean a skill failed/);
});
