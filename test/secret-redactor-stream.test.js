import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createSecretRedactor, redactSecretValues } = await import("../src/util/redact.js");

// A fine-grained GitHub token is 93 characters. Under the flat (longest secret - 1) holdback this
// one value alone made every live reply in the channel trail the model by 92 characters.
const GITHUB_PAT = `github_pat_${"A1b2C3d4E5f6G7h8I9j0".repeat(4)}XY`;
const OAUTH = `sk-ant-oat01-${"zyxwvutsrqponmlkjihgfedcba".repeat(4)}-end`;
const PREAMBLE = "Let me look at the screenshot, then check whether the restart actually happened and whether the mechanism I fixed is really what is happening here.";

test("ordinary prose streams through without a holdback, however long the configured secrets are", () => {
  const redactor = createSecretRedactor([GITHUB_PAT, OAUTH]);
  assert.equal(redactor.push(PREAMBLE), PREAMBLE, "nothing in the sentence can begin either secret, so all of it is emitted at once");
  assert.equal(redactor.flush(), "");
});

test("token-sized deltas are emitted as they arrive — the live reply keeps pace with the model", () => {
  const redactor = createSecretRedactor([GITHUB_PAT, OAUTH]);
  let seen = "";
  let maxLag = 0;
  for (const word of PREAMBLE.split(/(?<= )/)) {
    seen += redactor.push(word);
    maxLag = Math.max(maxLag, PREAMBLE.indexOf(word) + word.length - seen.length);
  }
  seen += redactor.flush();
  assert.equal(seen, PREAMBLE);
  // A word ending in "g" could in theory start "github_pat_…", so a lag of a few characters is
  // legitimate; a lag of dozens is the bug.
  assert.ok(maxLag <= 2, `the stream must never trail the model by more than a possible prefix (saw ${maxLag})`);
});

test("a secret split one character at a time never leaks, in any prefix of the stream", () => {
  const redactor = createSecretRedactor([GITHUB_PAT]);
  const text = `token: ${GITHUB_PAT} done`;
  let out = "";
  for (const char of text) {
    out += redactor.push(char);
    // Not even a recognizable fragment: the only thing that may be visible of the value is a
    // short prefix that could still be prose (the holdback releases nothing it cannot rule out).
    for (let i = 0; i + 8 <= GITHUB_PAT.length; i += 1) {
      assert.ok(!out.includes(GITHUB_PAT.slice(i, i + 8)), `an 8-char fragment of the token leaked at "${out.slice(-20)}"`);
    }
  }
  out += redactor.flush();
  assert.equal(out, "token: [REDACTED] done");
});

test("a pending prefix is held, then released the moment it diverges from every secret", () => {
  const redactor = createSecretRedactor(["sbp_abcdefgh12345678"]);
  assert.equal(redactor.push("use sbp_abc"), "use ", "the possible prefix waits");
  assert.equal(redactor.push("xyz"), "sbp_abcxyz", "it stopped being a prefix, so it is released verbatim");
  assert.equal(redactor.flush(), "");
});

test("a pending prefix is released verbatim by flush when the run ends on it", () => {
  const redactor = createSecretRedactor(["sbp_abcdefgh12345678"]);
  assert.equal(redactor.push("see sbp_ab"), "see ");
  assert.equal(redactor.flush(), "sbp_ab", "an answer never loses its tail");
});

test("a short secret that is a prefix of a longer one stays pending until the longer one is decided", () => {
  const short = "abcdefgh12";
  const long = "abcdefgh12XYZ9876";
  const longer = createSecretRedactor([short, long]);
  assert.equal(longer.push("abcdefgh12"), "", "could still be the long value");
  assert.equal(longer.push("XYZ9876!"), "[REDACTED]!", "the long value is redacted whole, not as a redacted short plus a leaked suffix");
  const shorter = createSecretRedactor([short, long]);
  assert.equal(shorter.push("abcdefgh12"), "");
  assert.equal(shorter.push("QQ"), "[REDACTED]QQ", "the short value on its own is redacted once the long one is ruled out");
});

test("a secret that ends inside another secret's pending prefix is never split by the emit boundary", () => {
  const redactor = createSecretRedactor(["abcdefgh", "ghLONGSECRET1"]);
  const first = redactor.push("x abcdefgh");
  assert.ok(!first.includes("abcdef"), `the complete first value must not leak as a fragment (got "${first}")`);
  const rest = redactor.push(" end") + redactor.flush();
  assert.equal(first + rest, "x [REDACTED] end");
});

test("the streamed result agrees with whole-text redaction for a mixed answer", () => {
  const secrets = [GITHUB_PAT, OAUTH, "sbp_abcdefgh12345678"];
  const text = `Use ${GITHUB_PAT} for GitHub and ${OAUTH} for Claude.\nThe db key sbp_abcdefgh12345678 is separate; sbp_abc on its own is fine.\n`;
  for (const size of [1, 3, 7, 50]) {
    const redactor = createSecretRedactor(secrets);
    let out = "";
    for (let i = 0; i < text.length; i += size) out += redactor.push(text.slice(i, i + size));
    out += redactor.flush();
    assert.equal(out, redactSecretValues(text, secrets), `chunk size ${size}`);
  }
});

test("values below the redactable floor and regex metacharacters are handled", () => {
  const redactor = createSecretRedactor(["abc", "p@ss.w0rd(1)+[x]"]);
  assert.equal(redactor.push("abc stays; p@ss.w0rd(1)+[x] goes") + redactor.flush(), "abc stays; [REDACTED] goes");
});

test("a large chunk with many long secrets is redacted promptly", () => {
  const secrets = Array.from({ length: 40 }, (_, i) => `tok_${String(i).padStart(3, "0")}_${"q".repeat(90)}`);
  const redactor = createSecretRedactor(secrets);
  const chunk = `${"log line without anything secret in it\n".repeat(2_000)}${secrets[7]}\n`;
  const started = Date.now();
  const out = redactor.push(chunk) + redactor.flush();
  assert.ok(Date.now() - started < 1_000, "a background job's 80 KB log chunk must not stall the daemon");
  assert.ok(out.endsWith("[REDACTED]\n"));
  assert.ok(!out.includes(secrets[7]));
});
