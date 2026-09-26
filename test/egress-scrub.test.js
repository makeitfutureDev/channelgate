// Response scrubbing (src/gateway/egress/scrub.js): a real value an upstream echoes back is put
// back to its placeholder before the container sees it, even when the value straddles two chunks,
// while binary bodies and short values pass through byte-for-byte.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createScrubber, isScrubbableContentType, MIN_SCRUB_LENGTH } = await import("../src/gateway/egress/scrub.js");
const { mintPlaceholder } = await import("../src/gateway/egress/placeholders.js");

async function run(stream, chunks) {
  const out = [];
  const reader = Readable.from(chunks.map((c) => Buffer.from(c))).pipe(stream);
  for await (const chunk of reader) out.push(chunk);
  return { text: Buffer.concat(out).toString("utf8"), pieces: out.length };
}

test("a value split across two chunks is still replaced", async () => {
  const value = `real-${crypto.randomBytes(16).toString("hex")}`;
  const ph = mintPlaceholder({ scope: "channel" });
  const body = `{"echo":"${value}","again":"${value}"}`;
  for (let cut = 1; cut < body.length; cut += 1) {
    const { text } = await run(createScrubber(new Map([[value, ph]]), "application/json"), [body.slice(0, cut), body.slice(cut)]);
    assert.equal(text, `{"echo":"${ph}","again":"${ph}"}`, `cut at ${cut}`);
  }
  // One byte per chunk is the worst case of the same thing.
  const { text } = await run(createScrubber({ [value]: ph }, "text/plain"), [...body]);
  assert.equal(text, `{"echo":"${ph}","again":"${ph}"}`);
});

test("streaming stays live: only a possible value prefix is held back", async () => {
  const value = `real-${crypto.randomBytes(16).toString("hex")}`;
  const ph = mintPlaceholder({ scope: "relay" });
  const scrubber = createScrubber(new Map([[value, ph]]), "text/event-stream");
  const seen = [];
  scrubber.on("data", (chunk) => seen.push(chunk.toString()));
  scrubber.write("data: hello\n\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.join(""), "data: hello\n\n", "an event with no value prefix is emitted at once");
  scrubber.write(`data: ${value.slice(0, 6)}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.join(""), "data: hello\n\ndata: ", "the ambiguous tail waits for the next chunk");
  scrubber.end(`${value.slice(6)}\n\n`);
  await new Promise((resolve) => scrubber.on("end", resolve).resume());
  assert.equal(seen.join(""), `data: hello\n\ndata: ${ph}\n\n`);
});

test("longest value wins, multibyte text survives, short values are not scrubbed", async () => {
  const short = "abc12345";
  const long = `${short}-and-more-${crypto.randomBytes(4).toString("hex")}`;
  const map = new Map([[short, "PH_SHORT_1"], [long, "PH_LONG_1"], ["tiny", "PH_TINY"]]);
  const { text } = await run(createScrubber(map, "text/plain; charset=utf-8"), [`ünïcødé ${long} / ${short} / tiny ✓`]);
  assert.equal(text, "ünïcødé PH_LONG_1 / PH_SHORT_1 / tiny ✓");
  assert.equal(MIN_SCRUB_LENGTH, 8);
});

test("binary and unknown content types pass through untouched", async () => {
  const value = `real-${crypto.randomBytes(16).toString("hex")}`;
  const map = new Map([[value, mintPlaceholder({ scope: "org" })]]);
  const payload = Buffer.concat([crypto.randomBytes(64), Buffer.from(value), crypto.randomBytes(64)]);
  for (const type of ["application/octet-stream", "image/png", "application/gzip", ""]) {
    const chunks = [];
    const stream = Readable.from([payload.subarray(0, 70), payload.subarray(70)]).pipe(createScrubber(map, type));
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(payload), type || "(none)");
  }
  assert.equal(isScrubbableContentType("application/vnd.api+json"), true);
  assert.equal(isScrubbableContentType("application/x-www-form-urlencoded"), true);
  assert.equal(isScrubbableContentType("application/javascript; charset=utf-8"), true);
  assert.equal(isScrubbableContentType("TEXT/HTML"), true);
  assert.equal(isScrubbableContentType("application/pdf"), false);
  assert.equal(isScrubbableContentType(undefined), false);
  // Nothing to scrub → a plain passthrough, even for text.
  const { text } = await run(createScrubber(new Map(), "text/plain"), ["unchanged"]);
  assert.equal(text, "unchanged");
});
