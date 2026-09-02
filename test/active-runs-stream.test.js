import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;

const { createWebApp } = await import("../src/web/app.js");
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { clearActiveRun, recordActiveRun, updateActiveRunRuntime } = await import("../src/gateway/active-runs.js");

saveSettings({ adminPassword: await hashPassword("active-runs-stream-password") });
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

function sseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(type = "active-runs") {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event === type && data) return JSON.parse(data);
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before the expected event");
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      }
    },
    cancel: () => reader.cancel(),
  };
}

test("active-run SSE sends an initial snapshot and every lifecycle transition", async () => {
  const id = "gateway-slack::stream-test";
  clearActiveRun(id);
  const controller = new AbortController();
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "active-runs-stream-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const response = await fetch(`${base}/api/active-runs/stream`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const events = sseReader(response.body);

  assert.deepEqual(await events.next(), { runs: [], count: 0 });

  recordActiveRun(id, {
    channelId: "C123",
    slug: "gateway-slack",
    authorId: "U123",
    threadKey: "123.456",
    text: "must stay server-side",
    attachments: ["uploads/private.png"],
    startedAt: 1_720_000_000_000,
  });
  const started = await events.next();
  assert.equal(started.count, 1);
  assert.equal(started.runs[0].id, id);
  assert.equal("text" in started.runs[0], false);
  assert.equal("attachments" in started.runs[0], false);

  updateActiveRunRuntime(id, { engine: "codex", model: "gpt-5.4" });
  const enriched = await events.next();
  assert.equal(enriched.runs[0].engine, "codex");
  assert.equal(enriched.runs[0].model, "gpt-5.4");

  // A new EventSource gets the complete current state immediately, repairing anything it could
  // have missed while disconnected.
  await events.cancel();
  controller.abort();
  const reconnectController = new AbortController();
  const reconnectResponse = await fetch(`${base}/api/active-runs/stream`, {
    headers: { cookie },
    signal: reconnectController.signal,
  });
  const reconnected = sseReader(reconnectResponse.body);
  const reconciled = await reconnected.next();
  assert.equal(reconciled.count, 1);
  assert.equal(reconciled.runs[0].engine, "codex");

  clearActiveRun(id);
  assert.deepEqual(await reconnected.next(), { runs: [], count: 0 });

  await reconnected.cancel();
  reconnectController.abort();
});
