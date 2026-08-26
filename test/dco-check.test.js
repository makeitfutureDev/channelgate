import assert from "node:assert/strict";
import test from "node:test";

import { hasSignOff } from "../scripts/check-dco.mjs";

const body = (...lines) => lines.join("\n");

test("a commit signed off by `git commit -s` is accepted", () => {
  assert.equal(
    hasSignOff(body("Add a thing", "", "Why it exists.", "", "Signed-off-by: Ada Lovelace <ada@example.com>")),
    true,
  );
});

test("sign-off is accepted next to other trailers and in any letter case", () => {
  assert.equal(
    hasSignOff(
      body(
        "Fix the thing",
        "",
        "Co-Authored-By: Someone Else <else@example.com>",
        "signed-off-by: Ada Lovelace <ada@example.com>",
        "Reviewed-by: Nobody <nobody@example.com>",
      ),
    ),
    true,
  );
  assert.equal(hasSignOff(body("Subject", "", "Signed-off-by:\tAda Lovelace <ada@example.com>")), true);
  assert.equal(hasSignOff(body("Subject", "", "Signed-off-by: Ada Lovelace <ada@example.com>   ")), true);
  assert.equal(
    hasSignOff(body("Subject", "", "Signed-off-by: Ada Lovelace <ada@example.com>\r")),
    true,
    "a CRLF commit message still carries a valid trailer",
  );
});

test("a commit with no trailer at all is rejected", () => {
  assert.equal(hasSignOff(body("Add a thing", "", "Why it exists.")), false);
  assert.equal(hasSignOff(""), false);
});

test("malformed trailers are rejected", () => {
  const malformed = [
    "Signed-off-by: Ada Lovelace", // no address
    "Signed-off-by: <ada@example.com>", // no name
    "Signed-off-by: Ada Lovelace <>", // empty address
    "Signed-off-by: Ada Lovelace <ada>", // not a mailbox
    "Signed-off-by: Ada Lovelace <ada@example>", // no domain dot
    "Signed-off-by: Ada Lovelace <ada at example.com>", // spaces inside the brackets
    "Signed-off-by:Ada Lovelace <ada@example.com>", // no space after the colon
    "Signed-off-by: Ada Lovelace <ada@example.com> and friends", // trailing text
    "Signed-off-by: Ada Lovelace <ada@example.com", // unterminated
  ];
  for (const line of malformed) {
    assert.equal(hasSignOff(body("Subject", "", line)), false, `should reject: ${line}`);
  }
});

test("a sign-off must own its line, not be quoted inside prose", () => {
  assert.equal(
    hasSignOff(body("Subject", "", "The docs say to add Signed-off-by: Ada Lovelace <ada@example.com> here.")),
    false,
  );
  assert.equal(hasSignOff(body("Subject", "", "  Signed-off-by: Ada Lovelace <ada@example.com>")), false);
  assert.equal(hasSignOff(body("Subject", "", "> Signed-off-by: Ada Lovelace <ada@example.com>")), false);
});

test("non-string input is rejected instead of throwing", () => {
  for (const value of [undefined, null, 0, {}, ["Signed-off-by: Ada <ada@example.com>"]]) {
    assert.equal(hasSignOff(value), false);
  }
});
