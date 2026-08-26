// Unit tests for the Markdown → Slack-mrkdwn converter: entity escaping (H2), mention/broadcast
// neutralization, code byte-exactness, the mrkdwn edge cases (italic/bolditalic/URLs with parens),
// and the chunker used to post long replies. Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";

import { mdToMrkdwn, chunkMrkdwn, buildReplyBlocks, resolveMentions, defangControlSeqs, createMentionStream } from "../src/slack/format.js";
import { buildDirectory } from "../src/slack/directory.js";

// ── Escaping (H2) ─────────────────────────────────────────────────────────────────────────────

test("escapes & < > in prose", () => {
  assert.equal(mdToMrkdwn("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
});

test("neutralizes raw user mentions from model text", () => {
  assert.equal(mdToMrkdwn("ping <@U0BAQFWHNAK> now"), "ping &lt;@U0BAQFWHNAK&gt; now");
});

test("neutralizes channel broadcasts", () => {
  assert.equal(mdToMrkdwn("<!channel> wake up"), "&lt;!channel&gt; wake up");
  assert.equal(mdToMrkdwn("hey <!here>"), "hey &lt;!here&gt;");
  assert.equal(mdToMrkdwn("<!everyone>"), "&lt;!everyone&gt;");
});

test("neutralizes raw channel links", () => {
  assert.equal(mdToMrkdwn("see <#C12345|general>"), "see &lt;#C12345|general&gt;");
});

test("already-escaped entities are double-escaped (raw text is treated literally)", () => {
  // The model writing "&amp;" means the literal text "&amp;" — it renders as such.
  assert.equal(mdToMrkdwn("&amp;"), "&amp;amp;");
});

// ── Code byte-exactness ───────────────────────────────────────────────────────────────────────

test("inline code spans are byte-exact", () => {
  assert.equal(mdToMrkdwn("run `a < b && <@U1>` now"), "run `a < b && <@U1>` now");
});

test("fenced code blocks are byte-exact", () => {
  const src = "```\n<!channel> & <@U123>\na < b\n**not bold**\n```";
  assert.equal(mdToMrkdwn(src), src);
});

test("prose around a fence is still escaped", () => {
  const out = mdToMrkdwn("a < b\n```\nc < d\n```\ne > f");
  assert.equal(out, "a &lt; b\n```\nc < d\n```\ne &gt; f");
});

// ── Links ─────────────────────────────────────────────────────────────────────────────────────

test("markdown links become Slack links", () => {
  assert.equal(mdToMrkdwn("[docs](https://example.com/x)"), "<https://example.com/x|docs>");
});

test("URLs containing parens no longer truncate", () => {
  assert.equal(
    mdToMrkdwn("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"),
    "<https://en.wikipedia.org/wiki/Foo_(bar)|Foo>"
  );
});

test("link URL and label are entity-escaped inside the link syntax", () => {
  assert.equal(
    mdToMrkdwn("[R&D](https://example.com/?a=1&b=2)"),
    "<https://example.com/?a=1&amp;b=2|R&amp;D>"
  );
});

test("link labels keep their emphasis converted", () => {
  assert.equal(mdToMrkdwn("[**bold** label](https://x.com/)"), "<https://x.com/|*bold* label>");
});

test("markdown autolinks stay live", () => {
  assert.equal(mdToMrkdwn("see <https://example.com/a?b=1&c=2>"), "see <https://example.com/a?b=1&amp;c=2>");
});

test("a fake link with a javascript: scheme is escaped, not linked", () => {
  assert.equal(mdToMrkdwn("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

// ── Emphasis edge cases ───────────────────────────────────────────────────────────────────────

test("**bold** becomes Slack *bold*", () => {
  assert.equal(mdToMrkdwn("some **bold** text"), "some *bold* text");
});

test("__bold__ becomes Slack *bold*", () => {
  assert.equal(mdToMrkdwn("some __bold__ text"), "some *bold* text");
});

test("single *italic* becomes Slack _italic_ (not bold)", () => {
  assert.equal(mdToMrkdwn("some *italic* text"), "some _italic_ text");
});

test("***bolditalic*** becomes Slack *_bolditalic_*", () => {
  assert.equal(mdToMrkdwn("some ***both*** text"), "some *_both_* text");
});

test("adjacent italics both convert", () => {
  assert.equal(mdToMrkdwn("*a* *b*"), "_a_ _b_");
});

test("multiplication-like asterisk use is left alone", () => {
  assert.equal(mdToMrkdwn("2 * 3 * 4"), "2 * 3 * 4");
});

test("~~strike~~ becomes ~strike~", () => {
  assert.equal(mdToMrkdwn("~~gone~~"), "~gone~");
});

// ── Structure ─────────────────────────────────────────────────────────────────────────────────

test("headings become bold lines", () => {
  assert.equal(mdToMrkdwn("## Heading <b>"), "*Heading &lt;b&gt;*");
});

test("bullets become dots and their text is escaped", () => {
  assert.equal(mdToMrkdwn("- a < b\n* c & d"), "• a &lt; b\n• c &amp; d");
});

test("blockquotes keep the live > marker but escape the body", () => {
  assert.equal(mdToMrkdwn("> quoted < text"), "> quoted &lt; text");
});

test("horizontal rules become a divider line", () => {
  assert.equal(mdToMrkdwn("---"), "──────────");
});

test("tables render as an aligned code block", () => {
  const out = mdToMrkdwn("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.ok(out.startsWith("```"));
  assert.ok(out.endsWith("```"));
  assert.ok(out.includes("a  b"));
  assert.ok(out.includes("1  2"));
});

test("empty input returns empty string", () => {
  assert.equal(mdToMrkdwn(""), "");
  assert.equal(mdToMrkdwn(null), "");
});

test("placeholder control chars in input can't forge a stash slot", () => {
  const NUL = String.fromCharCode(0);
  const SOH = String.fromCharCode(1);
  const out2 = mdToMrkdwn(`a${NUL}b${SOH}0${NUL}c`);
  assert.ok(!out2.includes(NUL));
  assert.ok(!out2.includes(SOH));
  assert.equal(out2, "ab0c");
});

// ── chunkMrkdwn (M9) ──────────────────────────────────────────────────────────────────────────

test("short text is a single chunk", () => {
  assert.deepEqual(chunkMrkdwn("hello", 100), ["hello"]);
});

test("splits on line boundaries under the budget", () => {
  const chunks = chunkMrkdwn("aaa\nbbb\nccc", 7);
  assert.deepEqual(chunks, ["aaa\nbbb", "ccc"]);
  for (const c of chunks) assert.ok(c.length <= 7);
});

test("hard-splits a single overlong line", () => {
  const chunks = chunkMrkdwn("x".repeat(25), 10);
  assert.equal(chunks.join(""), "x".repeat(25));
  for (const c of chunks) assert.ok(c.length <= 10);
});

test("keeps code fences valid across a split", () => {
  const text = "```\n" + "line one that is long\nline two that is long\n" + "```";
  const chunks = chunkMrkdwn(text, 30);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const fences = (c.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `chunk has unbalanced fences: ${JSON.stringify(c)}`);
  }
});

test("empty text yields one empty chunk", () => {
  assert.deepEqual(chunkMrkdwn("", 100), [""]);
});

test("reassembled chunks preserve all non-fence content", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} with some padding text`);
  const text = lines.join("\n");
  const chunks = chunkMrkdwn(text, 120);
  const rejoined = chunks.join("\n");
  for (const l of lines) assert.ok(rejoined.includes(l));
});

// ── buildReplyBlocks ──────────────────────────────────────────────────────────────────────────

test("buildReplyBlocks yields sections plus a footer context block", () => {
  const blocks = buildReplyBlocks("hello **world**", "1.2s · $0.01");
  assert.equal(blocks[0].type, "section");
  assert.equal(blocks[0].text.text, "hello *world*");
  assert.equal(blocks.at(-1).type, "context");
});

test("buildReplyBlocks handles empty content", () => {
  const blocks = buildReplyBlocks("", "");
  assert.equal(blocks[0].text.text, "_(no output)_");
});

// ── resolveMentions interplay with escaping ───────────────────────────────────────────────────

const dir = { map: new Map([["jane doe", "U777"]]), maxWords: 2 };

test("agent-written @Name still resolves to a live mention after escaping", () => {
  const md = mdToMrkdwn("cc @Jane Doe please");
  assert.equal(resolveMentions(md, dir), "cc <@U777> please");
});

test("resolveMentions leaves @channel alone", () => {
  assert.equal(resolveMentions("hey @channel", dir), "hey @channel");
});

// ── defangControlSeqs (native-streaming counterpart of escapeSlack) ───────────────────────────

test("defangs model-authored broadcasts and mentions in streamed text", () => {
  assert.equal(defangControlSeqs("cc <!channel> and <@U123> in <#C42>"), "cc &lt;!channel> and &lt;@U123> in &lt;#C42>");
  assert.equal(defangControlSeqs("a < b and 1<2 stay live-free"), "a < b and 1<2 stay live-free");
});

test("leaves code spans byte-exact when defanging", () => {
  assert.equal(defangControlSeqs("`<@U123>` and <@U123>"), "`<@U123>` and &lt;@U123>");
});

test("mention stream defangs sequences that straddle deltas", () => {
  const s = createMentionStream(null);
  const out = s.push("ping <") + s.push("!channel> now") + s.flush();
  assert.equal(out, "ping &lt;!channel> now");
});

// ── directory: ambiguous-name suppression ─────────────────────────────────────────────────────
// Regression: Sam Rivera's Slack handle is literally "sam", so a reply written as "Hi @Sam"
// resolved to THEM instead of Sam Lee. A bare first name shared by two people must resolve
// to nobody; the full name must still resolve exactly.

const MEMBERS = [
  { id: "U_LEE", name: "slee", real_name: "Sam Lee", profile: { display_name: "Sam Lee" } },
  { id: "U_RIVERA", name: "sam", real_name: "Sam Rivera", profile: { display_name: "Sam Rivera" } },
  { id: "U_ROSS", name: "tross", real_name: "Tomas Ross", profile: { display_name: "Tomas" } },
  { id: "U_GONE", name: "ghost", real_name: "Ghost User", deleted: true, profile: {} },
];

test("directory drops a first name two people answer to, keeps the full names", () => {
  const d = buildDirectory(MEMBERS);
  assert.equal(d.map.get("sam"), undefined, "bare @Sam must be unusable");
  assert.equal(d.map.get("sam lee"), "U_LEE");
  assert.equal(d.map.get("sam rivera"), "U_RIVERA");
  assert.equal(d.map.get("slee"), "U_LEE", "an unshared handle still resolves");
});

test("directory keeps a single-word name nobody else shares", () => {
  const d = buildDirectory(MEMBERS);
  assert.equal(d.map.get("tomas"), "U_ROSS", "self-overlap with one's own full name is not ambiguity");
  assert.equal(d.map.get("tomas ross"), "U_ROSS");
});

test("directory skips deleted accounts", () => {
  assert.equal(buildDirectory(MEMBERS).map.get("ghost"), undefined);
});

test("ambiguous first name is posted as literal text, full name resolves", () => {
  const d = buildDirectory(MEMBERS);
  assert.equal(resolveMentions("Hi @Sam — status", d), "Hi @Sam — status");
  assert.equal(resolveMentions("Hi @Sam Lee — status", d), "Hi <@U_LEE> — status");
});
