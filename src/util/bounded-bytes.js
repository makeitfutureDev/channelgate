// Byte caps for files the daemon accepts from the outside world (a Slack/Chat/Teams attachment, a
// webhook-supplied fileUrl), and the one wording every refusal uses.
//
// ATTACHMENT_MAX_BYTES is the ceiling for a single inbound attachment on every surface. It is a
// DISK budget, not a memory one: every sink streams the body straight into the channel folder
// (safe-fs.js writeStreamNoFollow) with the running total checked per chunk, so a 500 MB screen
// recording never sits in the daemon's heap. Slack itself allows 1 GB per file; 500 MB covers a
// long screen recording while keeping one message from filling a disk. Change it here, nowhere
// else — the sinks and the tests read this constant.
export const ATTACHMENT_MAX_BYTES = 500 * 1024 * 1024;

// "263.4 MB", "12 KB", "512 B" — for refusals and progress lines a person reads.
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "")} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

// The one refusal wording. `actual` may be null when only "more than the cap" is known (a stream
// that was cut off), and then the message names just the limit.
export function oversizeMessage(actual, maxBytes = ATTACHMENT_MAX_BYTES) {
  const limit = formatBytes(maxBytes);
  const known = Number.isFinite(Number(actual)) && Number(actual) > 0;
  return known ? `${formatBytes(actual)} exceeds the ${limit} attachment limit` : `exceeds the ${limit} attachment limit`;
}

// Read a fetch Response body into a Buffer under a hard byte cap, enforced WHILE streaming.
// Content-Length is a claim by the remote side, so it is only used as a cheap early reject — the
// running total is what actually stops the read, and the connection is cancelled the moment the
// cap is passed. Kept for small bodies a caller genuinely needs in memory; an attachment goes
// through writeStreamNoFollow instead, which applies the same rule on the way to disk.
export async function readBoundedBytes(res, maxBytes) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`downloaded file ${oversizeMessage(declared, maxBytes)}`);
  if (!res.body?.getReader) {
    // No web stream (a test double, or a body already buffered by the runtime) — cap after the fact.
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`downloaded file ${oversizeMessage(bytes.length, maxBytes)}`);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`downloaded file ${oversizeMessage(null, maxBytes)}`);
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, total);
}
