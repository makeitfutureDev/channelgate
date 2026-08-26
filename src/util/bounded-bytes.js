// Read a fetch Response body into a Buffer under a hard byte cap, enforced WHILE streaming.
// Content-Length is a claim by the remote side (Slack, or any webhook-supplied URL), so it is only
// used as a cheap early reject — the running total is what actually stops the read, and the
// connection is cancelled the moment the cap is passed. Shared by the two attachment sinks
// (slack/message-pipeline.js downloads and gateway/api-runs.js fileUrl fetches) so both refuse an
// oversized body identically instead of buffering it whole first.
export async function readBoundedBytes(res, maxBytes) {
  const limit = `${Math.round(maxBytes / 1024 / 1024)}MB`;
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`downloaded file exceeds the ${limit} limit`);
  if (!res.body?.getReader) {
    // No web stream (a test double, or a body already buffered by the runtime) — cap after the fact.
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`downloaded file exceeds the ${limit} limit`);
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
      if (total > maxBytes) throw new Error(`downloaded file exceeds the ${limit} limit`);
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, total);
}
