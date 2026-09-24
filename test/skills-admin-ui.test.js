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
  assert.match(js, /searchBox\("usage-q"/);
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

// A search box used to filter per keystroke, and filtering re-rendered the whole panel — the
// replacement input came back focused at offset 0, so typing a query scattered its characters.
// Searching is now a deliberate act (Enter, the Search button, or clearing the box), and any
// render that does happen under a focused field restores the caret.
test("skills searches commit on Enter or the Search button, never per keystroke", () => {
  assert.match(js, /const SEARCH_BOXES = Object\.freeze\(\{/);
  for (const id of ["skills-q", "source-skills-q", "usage-q"]) {
    assert.match(js, new RegExp(`"${id}": \\{ draft:`), `${id} keeps a draft separate from the committed query`);
    assert.match(js, new RegExp(`searchBox\\("${id}"`), `${id} renders through the shared search box`);
  }
  assert.match(js, /data-action="search" data-search="\$\{id\}"/);
  assert.match(js, /if \(action === "search"\) \{\n\s+await commitSearch\(el\.dataset\.search\);/);
  // Typing records the draft and nothing else: no render, so no caret to lose.
  assert.match(js, /state\[box\.draft\] = event\.target\.value;\n\s+markSearchPending\(event\.target\.id\);/);
  assert.doesNotMatch(js, /state\.sourceQuery = event\.target\.value;/);
  assert.doesNotMatch(js, /state\.usageQuery = event\.target\.value;/);
  // Enter and Escape commit; the browser's own × on input[type=search] does too.
  assert.match(js, /event\.key !== "Enter" && event\.key !== "Escape"/);
  assert.match(js, /root\.addEventListener\("search"/);
  // Blur does not search: skills-q is no longer in the change-triggered filter list.
  assert.doesNotMatch(js, /\["skills-q", "skills-owner"/);
  // And every render puts the caret back where the reader left it.
  assert.match(js, /const focused = captureFocus\(\);\n\s+body\(\)\.innerHTML = /);
  assert.match(js, /restoreFocus\(focused\);/);
  assert.match(js, /el\.setSelectionRange\(Math\.min\(snapshot\.start, limit\)/);
  assert.match(css, /\.skills-toolbar \.skills-search-go\.pending \{/);
});
