// M11: slugify must always yield a single safe path component — it's joined under
// channelsDir()/workspaceRoot(), so "." / ".." / separator-bearing names must never survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { slugify } from "../src/config/paths.js";

test("keeps readable channel names", () => {
  assert.equal(slugify("#team-ops"), "team-ops");
  assert.equal(slugify("Sales & Ops"), "sales-ops");
  assert.equal(slugify("release-v1.2"), "release-v1.2"); // inner dots are fine
});

test("rejects dot-only names (no traversal segments)", () => {
  assert.equal(slugify(".", "D123"), "id-d123");
  assert.equal(slugify("..", "D123"), "id-d123");
  assert.equal(slugify("...", "D123"), "id-d123");
});

test("strips leading/trailing dots and hyphens", () => {
  assert.equal(slugify("..foo.."), "foo");
  assert.equal(slugify(".hidden"), "hidden"); // no dot-folders either
  assert.equal(slugify("-.-x-.-"), "x");
});

test("path separators can never survive", () => {
  assert.equal(slugify("../x"), "x");
  assert.equal(slugify("a/b"), "a-b");
  assert.equal(slugify("..\\..\\etc"), "etc");
  for (const evil of ["../../etc/passwd", "..", ".", "a/../..", "\\\\server\\share"]) {
    const slug = slugify(evil, "D1");
    assert.ok(!slug.includes("/") && !slug.includes("\\"), `no separators in ${JSON.stringify(slug)}`);
    assert.notEqual(slug, ".");
    assert.notEqual(slug, "..");
    // Joining under a root must stay under that root.
    const root = "/tmp/channels";
    assert.ok(path.resolve(root, slug).startsWith(root + path.sep), `confined: ${slug}`);
  }
});

test("empty / unusable names fall back to the sanitized id", () => {
  assert.equal(slugify("", "D07ABC"), "id-d07abc");
  assert.equal(slugify(undefined, undefined), "id-unknown");
  assert.equal(slugify("###", "../D1"), "id-d1"); // the fallback id is sanitized too
});
