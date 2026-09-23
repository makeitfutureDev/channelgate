// Admin-UI controls must carry their own box styling.
//
// There is no global `input` rule in public/styles.css — every context styles its own, and
// `.field input` is the canonical control. A widget that relies on an ANCESTOR for its look
// therefore renders correctly in the one place it was built and falls back to the browser default
// everywhere else: a small grey box. That shipped twice (the shared secret editor borrowing the
// conversation card's classes, and `.tok-label`, which was styled only when it happened to sit
// inside a `.field`), so the property is asserted here rather than rediscovered from a screenshot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

// The declarations that make a control look like a control rather than a UA default.
const BOX = ["background:", "border:", "border-radius:", "padding:"];

function ruleFor(selector) {
  // Selector at the start of a rule, up to its closing brace. Escaped for a literal match.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1] : "";
}

for (const selector of [".tok-label", ".secret-add input"]) {
  test(`${selector} styles the control itself, not via an ancestor`, () => {
    const rule = ruleFor(selector);
    assert.ok(rule, `${selector} has its own rule`);
    for (const decl of BOX) assert.ok(rule.includes(decl), `${selector} sets ${decl}`);
    // var(--panel-2) + var(--line) is what every other control in the admin UI uses; a literal
    // colour here would drift the moment the palette changes.
    assert.match(rule, /var\(--panel-2\)/, `${selector} uses the shared surface colour`);
    assert.match(rule, /var\(--line\)/, `${selector} uses the shared border colour`);
  });
}

test("a description is small wherever it is written, not only inside a .setcard", () => {
  // `.setcard .desc` meant the same paragraph rendered at body size in the user drawer.
  assert.ok(ruleFor(".desc"), ".desc has an unscoped rule");
  assert.doesNotMatch(css, /^\.setcard \.desc\s*\{/m, "the .setcard-only rule is gone");
});

test("the secret editor's own classes are what it renders, so no host's classes can be dropped", () => {
  const js = readFileSync(new URL("../public/admin-secrets.js", import.meta.url), "utf8");
  for (const cls of ["secret-list", "secret-add", "secret-name", "secret-value", "secret-save", "secret-row"]) {
    assert.ok(js.includes(cls), `admin-secrets.js renders .${cls}`);
  }
  // The containers carry rules of their own; the two inputs are covered by `.secret-add input`
  // above, which is the point — one rule, so a new field inside the editor cannot miss it.
  for (const cls of ["secret-list", "secret-add", "secret-row"]) {
    assert.ok(ruleFor(`.${cls}`), `.${cls} is styled`);
  }
  // The conversation card used to hand-write this markup in index.html; one source only now.
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /class="secret-list"/, "the markup comes from secretEditorMarkup()");
});
