import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const js = await readFile(new URL("../public/admin-skills.js", import.meta.url), "utf8");
const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

test("source dialog offers only GitHub and ChannelGate with kind-specific fields", () => {
  assert.match(js, /<option value="git">GitHub repository<\/option><option value="gateway">Other ChannelGate<\/option>/);
  assert.doesNotMatch(js, /<option value="folder">Folder on the gateway host<\/option>/);
  assert.match(js, /data-source-kind="git"/);
  assert.match(js, /data-source-kind="gateway" hidden/);
  assert.doesNotMatch(js, /id="src-ref"|id="src-subpath"/);
  assert.match(js, /skillsPublishBranch: "main"/);
  assert.match(js, /data-action="save-source-secret"/);
});

test("Skills admin navigation separates sources, synchronization and MCP", () => {
  assert.match(html, /data-tab="sources"[^>]*>Sources/);
  assert.match(html, /data-tab="sync"[^>]*>Sync settings/);
  assert.match(html, /data-tab="mcp"[^>]*>MCP/);
  assert.match(js, /data-action="open-source"/);
  assert.match(js, /role="dialog"[^>]*aria-labelledby="add-source-title"/);
});

test("templates and usage expose searchable selection and understandable views", () => {
  assert.match(js, /id="template-select"/);
  assert.match(js, /mountSkillAssignmentPicker\(picker/);
  assert.match(js, /id="template-skills-picker"/);
  assert.doesNotMatch(js, /Explicit skills \(comma-separated slugs\)/);
  assert.match(js, /data-view="skill"/);
  assert.match(js, /data-view="channel"/);
  assert.match(js, /id="usage-q"/);
  assert.doesNotMatch(js, /Whole categories/);
  assert.doesNotMatch(js, /Assign a template to a conversation/);
  assert.match(js, /<th>Usage<\/th>/);
  assert.doesNotMatch(js, /<th>Exact<\/th>/);
  // The report explains how it counts (exact vs inferred, not retroactive); the panel used to
  // drop `notes` on the floor, so a viewer had no way to know an inferred total is a lower bound.
  assert.match(js, /How this is counted:<\/strong> \$\{\(r\.notes \|\| \[\]\)\.map/);
  // …and a grant answers with its own warnings, shown where the grant was made.
  assert.match(js, /\(r\.warnings \|\| \[\]\)\.length \? ` Warning: \$\{r\.warnings\.join\("; "\)\}\.` : ""/);
  assert.match(js, /skill-discoverable/);
  assert.match(js, /skill-mandatory/);
  assert.match(js, /does not mean a skill failed/);
});

test("catalog filters keep owner and expose governance plus assignment states", () => {
  for (const id of ["skills-owner", "skills-enabled", "skills-discoverable", "skills-mandatory", "skills-assigned"]) {
    assert.match(js, new RegExp(`id="${id}"`));
  }
  assert.match(js, /binaryOptions\(state\.enabled, "enabled or disabled", "Enabled", "Disabled"\)/);
  assert.match(js, /binaryOptions\(state\.discoverable, "discoverable or not", "Discoverable", "Not discoverable"\)/);
  assert.match(js, /binaryOptions\(state\.mandatory, "mandatory or not", "Mandatory", "Not mandatory"\)/);
  assert.match(js, /binaryOptions\(state\.assigned, "assigned or not", "Assigned", "Not assigned"\)/);
  assert.match(js, /import \{ filterSkillCatalog \} from "\.\/skills-catalog-filters\.js"/);
  assert.match(js, /api\(`\/api\/skills\/catalog\?\$\{filters\}&deleted=1`\)/);
  assert.match(js, /skills: filterSkillCatalog\(catalog\.skills/);
  assert.match(js, /id="skills-category"/);
  assert.match(js, /id="skills-source"/);
  assert.doesNotMatch(js, /id="skills-removed"/);
});

// An author `display` declaration beats the UA stylesheet's `[hidden] { display: none }` whatever
// its specificity, so every class the admin JS hides by setting `.hidden` needs a companion rule.
// Without it the source dialog showed the GitHub and ChannelGate fields at the same time.
test("what the admin JS hides with the hidden property is actually hidden", () => {
  assert.match(js, /querySelectorAll\("\[data-source-kind\]"\)\) field\.hidden = /);
  assert.match(css, /\.field\[hidden\] \{ display: none; \}/);
});
