// The Host/Origin guard is the one refusal an operator can fix, and the Settings page that fixes
// it sits behind the guard. So the refusal has to be legible from the browser: a machine-readable
// code on the wire, and a visible panel instead of a console line under a page stuck on "Loading…".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;

const { createWebApp } = await import("../src/web/app.js");
const app = createWebApp({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } });

function get(url, headers) {
  return new Promise((resolve) => {
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.url = url;
    request.headers = headers;
    const response = new ServerResponse(request);
    const chunks = [];
    const collect = (chunk, encoding) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    };
    response.write = (chunk, encoding, done) => { collect(chunk, encoding); if (typeof done === "function") done(); return true; };
    response.end = (chunk, encoding, done) => {
      collect(chunk, encoding);
      if (typeof done === "function") done();
      resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      return response;
    };
    app(request, response);
  });
}

test("the refusal is machine-readable and never echoes the attacker's Host", async () => {
  const response = await get("/api/health", { host: "gateway.attacker.test" });
  assert.equal(response.status, 403);
  const body = JSON.parse(response.body);
  assert.equal(body.code, "host_not_allowed");
  assert.match(body.error, /publicUrl/);
  // Reflecting the Host header would put attacker-controlled text on the recovery screen.
  assert.ok(!response.body.includes("attacker"), "the refusal must not echo the Host it received");
});

test("the shell itself stays reachable, so the recovery screen can render", async () => {
  const response = await get("/", { host: "gateway.attacker.test" });
  assert.equal(response.status, 200);
  assert.match(response.body, /<script type="module"/);
});

test("a loopback request is unaffected by the guard", async () => {
  const response = await get("/api/health", { host: "localhost:4747" });
  assert.notEqual(response.status, 403);
});

test("the client keeps the status and code, and paints a fatal panel instead of a console line", () => {
  const client = readFileSync(new URL("../public/admin-api.js", import.meta.url), "utf8");
  assert.match(client, /error\.status = res\.status/, "api() must preserve the HTTP status");
  assert.match(client, /if \(body\.code\) error\.code = body\.code/, "api() must preserve the server code");

  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /init\(\)\.catch\(showFatalError\)/, "a failed boot must be painted, not just logged");
  assert.match(app, /error\?\.code === "host_not_allowed"/, "the host refusal needs its own recovery copy");
  assert.match(app, /Settings → Public URL/, "the panel must name the setting that fixes it");
  assert.match(app, /loopback\n?\s*is always allowed/, "the panel must give the loopback escape hatch");
  assert.match(app, /CG_ALLOWED_HOSTS=/, "the panel must give the env-var alternative");
  // The hostname shown is the browser's own, and it is escaped — it lands in innerHTML.
  assert.match(app, /escapeHtml\(host\)/);
  assert.match(app, /escapeHtml\(window\.location\.origin\)/);

  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.fatal \{[^}]*position: fixed/, "the panel must cover the half-painted shell");
});
