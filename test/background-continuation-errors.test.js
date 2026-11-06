import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.SESSION_KEEPALIVE = "0";
process.env.PATH = path.join(import.meta.dirname, "fixtures") + path.delimiter + process.env.PATH;

const { useFakeRuntime, createFakeRuntimeBackend } = await import("./runtime-fake.js");
const backend = createFakeRuntimeBackend();
const spawn = backend.spawn.bind(backend);
const cli = path.join(scratch, "provider-error.mjs");
const canary = "synthetic-continuation-secret";
writeFileSync(cli, `
const padding = process.argv[2] === "claude" ? 390 - "Claude provider rejected the request: ".length : 390;
const body = process.argv[3] === "long"
  ? "x".repeat(padding) + "${canary}"
  : "The selected model is unavailable. ${canary}";
let message = JSON.stringify({ error: {
  message: body, code: "fixture_model_unavailable"
} });
if (process.argv[3] === "escaped") message = message.replace("synthetic-", "\\\\u0073ynthetic-");
const event = process.argv[2] === "codex"
  ? { type: "turn.failed", error: { message } }
  : { type: "assistant", error: "invalid_request_error", message: {
      role: "assistant", content: [{ type: "text", text: message }]
    } };
console.log(JSON.stringify(event));
process.exitCode = 1;
`);
let engine, scenario;
backend.spawn = (target, spec) => spawn(target, {
  ...spec, cmd: process.execPath, args: [cli, engine, scenario],
});
await useFakeRuntime(backend);

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { BackgroundJobs } = await import("../src/gateway/background.js");
const { readEvents } = await import("../src/util/logger.js");
const { getDb } = await import("../src/db/index.js");

for (const selected of ["claude", "codex"]) {
  for (const variant of ["ordinary", "long", "escaped"]) {
    test(`${selected} ${variant} CLI continuation failures stay readable, redacted and unreplayed`, async () => {
      engine = selected;
      scenario = variant;
      saveSettings({ engine, engineFallback: false, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
      await setUser("U_CONTINUATION", { name: "Fixture admin", isAdmin: true, approved: true });
      const channel = `D_CONTINUATION_${engine.toUpperCase()}`;
      const entry = await upsertChannelEntry(channel, { name: `continuation-${engine}`, type: "im", isDM: true });
      await saveChannelMeta(entry.slug, { channelId: channel, type: "im", isDM: true, template: "custom", engine, cleanMode: true, allowNetwork: false });
      const posts = [], errors = [];
      const client = { chat: { postMessage: async payload => {
        posts.push(payload);
        return { ok: true, ts: "1900000000.000001" };
      } } };
      const jobs = new BackgroundJobs({
        slack: { snapshot: () => ({ connected: true }), getClient: () => client },
        runner: async args => {
          try { return await runMessage({ ...args, preferCold: true }); }
          catch (error) { errors.push(error); throw error; }
        },
      });
      const rec = {
        id: `continuation-${engine}`, kind: "shell", channelId: channel, slug: entry.slug,
        authorId: "U_CONTINUATION", threadKey: "1900000000.000002", label: "fixture job",
        command: "true", startedAt: Date.now() - 1000, pid: null, maxMs: 60000,
        logFile: "", tail: "harmless output", timedOut: false, secretValues: [canary],
      };
      jobs.jobs.set(rec.id, rec);
      try {
        const before = backend.calls.spawn.length;
        // Real engine parser and runMessage; only runtime execution and transport are fixtures.
        await jobs._finish(rec, { code: 0 });
        assert.equal(backend.calls.spawn.length, before + 1);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].details.engine, engine);
        assert.equal(errors[0].details.providerError, true);
        assert.ok(errors[0].details.providerCode);
        assert.equal(errors[0].details.exitCode, 1);
        const notice = posts.find(post => post.text.includes("couldn't continue"))?.text;
        if (variant !== "long") assert.match(notice, /The selected model is unavailable\. \[REDACTED\]/);
        assert.doesNotMatch(notice, /\{\s*"error"|fixture_model_unavailable/);
        assert.ok(!notice.includes("synthetic-"), "no secret prefix survives truncation or JSON decoding");
        assert.ok(notice.split("couldn't continue: ")[1].length <= 400);
        const audit = readEvents({ limit: 200 }).find(row => row.event === "bg_continue_error" && row.id === rec.id);
        assert.ok(audit);
        assert.ok(!audit.error.includes(canary));
        if (engine === "claude") assert.match(audit.error, /fixture_model_unavailable/, "redacted diagnostic detail is preserved");
        await jobs._deliver(rec);
        assert.equal(backend.calls.spawn.length, before + 1, "unknown continuation effects are never replayed");
        assert.ok(posts.some(post => /continuation was interrupted/.test(post.text)));
        assert.equal(jobs.jobs.has(rec.id), false);
        assert.equal(getDb().prepare("SELECT id FROM bg_jobs WHERE id = ?").get(rec.id), undefined);
        assert.ok(backend.calls.leases.every(lease => lease.released));
      } finally {
        jobs.jobs.clear();
        getDb().prepare("DELETE FROM bg_jobs WHERE id = ?").run(rec.id);
      }
    });
  }
}
