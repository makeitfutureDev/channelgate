import assert from "node:assert/strict";
import test from "node:test";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { buildCallsView, createCallsViewAssets } = await import("../src/web/calls-view-assets.ts");

test("a Calls shell and its script stay paired through release and rollback", () => {
  const first = { html: "<section>Calls</section>", css: "section{margin:0}", ts: "const first: number = 1;" };
  const second = { ...first, ts: "const second: number = 2;" };
  let active = first;
  const assets = createCallsViewAssets(() => active);
  const original = assets.current();
  assert.doesNotMatch(original.script, /: number/);
  active = second;
  const next = assets.current();
  assert.notEqual(next.revision, original.revision);
  assert.equal(assets.script(original.revision), original.script);
  assert.equal(assets.script(next.revision), next.script);
  assert.equal(assets.script("unknown"), undefined);
  active = first;
  assert.equal(assets.current(), original);
  assert.equal(assets.script(next.revision), next.script);
  for (const part of ["html", "css", "ts"] as const) {
    assert.notEqual(buildCallsView({ ...first, [part]: first[part] + "\n" }).revision, original.revision);
  }
});

test("incompatible browser module syntax fails before a Calls view is activated", () => {
  assert.throws(() => buildCallsView({ html: "", css: "", ts: 'import "/unknown.js";' }), SyntaxError);
});
