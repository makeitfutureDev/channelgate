import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { boundedResponseBytes, fetchPublicUrl } = await import("../src/gateway/api-runs.js");

test("download byte cap rejects from content-length before consuming the body", async () => {
  let bodyRead = false;
  const response = {
    headers: new Headers({ "content-length": "11" }),
    get body() { bodyRead = true; throw new Error("body must not be touched"); },
  };
  await assert.rejects(boundedResponseBytes(response, 10), /exceeds/);
  assert.equal(bodyRead, false);
});

test("download byte cap cancels a chunked response as soon as it crosses the limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedResponseBytes(new Response(body), 10), /exceeds/);
  assert.equal(cancelled, true);
});

test("public fetch revalidates every redirect hop and blocks before requesting an unsafe target", async () => {
  const requested = [];
  const validated = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(null, { status: 302, headers: { location: requested.length === 1 ? "https://two.test/file" : "http://127.0.0.1/secret" } });
  };
  const validate = async (url) => {
    validated.push(String(url));
    if (String(url).includes("127.0.0.1")) throw new Error("resolves to a private address");
    return new URL(url);
  };

  await assert.rejects(
    fetchPublicUrl("https://one.test/file", {}, 3, { fetchImpl, validate }),
    /private address/
  );
  assert.deepEqual(requested, ["https://one.test/file", "https://two.test/file"]);
  assert.deepEqual(validated, ["https://one.test/file", "https://two.test/file", "http://127.0.0.1/secret"]);
});

test("the default fetch path hands the SSRF-vetted addresses to the request (pinning contract)", async () => {
  const seen = [];
  const fetchImpl = async (url, request, addresses) => {
    seen.push({ url: String(url), addresses });
    return new Response("ok", { status: 200 });
  };
  const validate = async (url) => ({ url: new URL(url), addresses: [{ address: "93.184.216.34", family: 4 }] });
  const { res } = await fetchPublicUrl("https://example.test/x", {}, 3, { fetchImpl, validate });
  assert.equal(res.status, 200);
  assert.deepEqual(seen[0].addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("credentials are stripped when a redirect changes origin", async () => {
  const headersSeen = [];
  const fetchImpl = async (url, request) => {
    headersSeen.push({ url: String(url), headers: { ...(request.headers || {}) } });
    return headersSeen.length === 1
      ? new Response(null, { status: 307, headers: { location: "https://other.test/y" } })
      : new Response("ok", { status: 200 });
  };
  const validate = async (url) => ({ url: new URL(url), addresses: [{ address: "93.184.216.34", family: 4 }] });
  await fetchPublicUrl("https://one.test/x", { headers: { Authorization: "Bearer sekret", "x-custom": "keep" } }, 3, { fetchImpl, validate });
  assert.equal(headersSeen[0].headers.Authorization, "Bearer sekret");
  assert.equal(headersSeen[1].headers.Authorization, undefined, "authorization must not cross origins");
  assert.equal(headersSeen[1].headers["x-custom"], "keep");
});
