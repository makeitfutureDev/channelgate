// Usage the gateway never launched — the scanners, the de-duplication, the pricing and the way it
// reaches the dashboard.
//
// The risk this feature carries is not "we miss some spend"; it is "we count the gateway's own
// spend twice and call it somebody working outside chat". Most of what follows is about that.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { usageDashboard } = await import("../src/gateway/usage.js");
const { scanClaudeTranscript, scanClaudeState, normalizeClaudeTokenUsage, claudeBillingModel, claudeOriginFor } =
  await import("../src/gateway/claude-usage.js");
const { scanCodexRollout, codexOriginFor } = await import("../src/engines/codex-usage.js");
const { priceClaudeTokens, priceCodexTokens, gatewaySessionIds, matchWorkdir, buildWorkdirIndex, saveScopeSessions, scanExternalUsage, foldTurnsIntoModels, sessionAttribution, externalScanStaleReason, externalScanFingerprint } =
  await import("../src/gateway/external-usage.js");

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function claudeTranscript(dir, sessionId, records) {
  const project = path.join(dir, "projects", "-work-demo");
  mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  writeFileSync(file, jsonl(records));
  return file;
}

function assistant(ts, model, usage, extra = {}) {
  return { type: "assistant", timestamp: ts, cwd: "/work/demo", entrypoint: "cli", version: "2.1.0", message: { model, usage }, ...extra };
}

const userTurn = (ts) => ({ type: "user", timestamp: ts, cwd: "/work/demo", entrypoint: "cli", message: { content: "do the thing" } });

// ── Claude transcript parsing ───────────────────────────────────────────────────────────────────
test("a Claude transcript becomes per-hour, per-model token aggregates", async () => {
  const dir = tempDir("claude-state");
  const file = claudeTranscript(dir, "s-1", [
    userTurn("2026-09-01T10:00:00.000Z"),
    assistant("2026-09-01T10:00:05.000Z", "claude-opus-5", {
      input_tokens: 10, output_tokens: 100,
      cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
    }),
    assistant("2026-09-01T10:30:00.000Z", "claude-opus-5", { input_tokens: 2, output_tokens: 20 }),
    // A different hour, a different model, and a subagent — whose spend is real and must count.
    assistant("2026-09-01T11:00:00.000Z", "claude-haiku-4-5-20251001", { input_tokens: 1, output_tokens: 5 }, { isSidechain: true }),
    // A local error reply never reached the API and carries no price.
    assistant("2026-09-01T11:05:00.000Z", "<synthetic>", { input_tokens: 999, output_tokens: 999 }),
  ]);

  const scan = await scanClaudeTranscript(file);
  assert.equal(scan.sessionId, "s-1");
  assert.equal(scan.cwd, "/work/demo");
  assert.equal(scan.origin, "terminal", "entrypoint `cli` is someone at a terminal");
  assert.equal(scan.turns, 1, "a tool result or a subagent prompt is not a turn");
  assert.equal(scan.requests, 3, "the synthetic record is not a request");

  const hour10 = scan.buckets.find((b) => b.bucket === "2026-09-01T10" && b.model === "claude-opus-5");
  assert.equal(hour10.requests, 2);
  assert.deepEqual(hour10.usage, {
    input_tokens: 12, cached_input_tokens: 5_000, cache_write_5m_tokens: 400, cache_write_1h_tokens: 600, output_tokens: 120,
  });
  // The dated snapshot collapses onto the family's billing id.
  assert.ok(scan.buckets.some((b) => b.bucket === "2026-09-01T11" && b.model === "claude-haiku-4-5"));
});

test("cache-write TTLs are kept apart, and an unsplit total falls back to the cheaper 5-minute rate", () => {
  assert.deepEqual(
    normalizeClaudeTokenUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 100 }),
    { input_tokens: 1, cached_input_tokens: 3, cache_write_5m_tokens: 100, cache_write_1h_tokens: 0, output_tokens: 2 },
  );
  // A split that does not account for the reported total is not trusted; the remainder goes to 5m.
  assert.deepEqual(
    normalizeClaudeTokenUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 30 } }),
    { input_tokens: 0, cached_input_tokens: 0, cache_write_5m_tokens: 70, cache_write_1h_tokens: 30, output_tokens: 0 },
  );
});

test("Claude spend is priced per token class, not by multiplying the input total", () => {
  const rates = { "claude-opus-5": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 } };
  const usage = { input_tokens: 1e6, cached_input_tokens: 1e6, cache_write_5m_tokens: 1e6, cache_write_1h_tokens: 1e6, output_tokens: 1e6 };
  assert.equal(priceClaudeTokens(usage, "claude-opus-5", rates), 46.75, "5 + 0.5 + 6.25 + 10 + 25");
  // The same tokens charged at the base input rate would be $20 of cache reads instead of $0.50 —
  // an agent session is mostly cache reads, so the difference is the whole number.
  assert.equal(priceClaudeTokens(usage, "claude-opus-5[1m]", rates), 46.75, "a context variant is not a separate price");
  assert.equal(priceClaudeTokens(usage, "some-model-we-do-not-price", rates), null, "unknown models stay unpriced, never guessed");
  assert.equal(claudeBillingModel("claude-opus-5-20260101"), "claude-opus-5");
});

test("Codex spend is priced from the same rate table the ledger uses", () => {
  const rates = { "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 } };
  const cost = priceCodexTokens({ input_tokens: 1e6, cached_input_tokens: 5e5, cache_write_input_tokens: 0, output_tokens: 1e6 }, "gpt-5.6-sol", rates);
  assert.equal(cost, 22.2, "500k fresh at $4 + 500k cached at $0.40 + 1M output at $20");
  assert.equal(priceCodexTokens({ input_tokens: 1 }, "gpt-9-unknown", rates), null);
});

// ── one API response is charged once ────────────────────────────────────────────────────────────
test("the blocks of one API response are billed once, not once each", async () => {
  // Claude Code writes one assistant record PER CONTENT BLOCK — same requestId, same message.id,
  // same `usage` object, different uuid and apiBlockIndex. Summing the records bills the request
  // two or three times over. Measured against the 52 development-machine sessions where Claude Code
  // recorded its own final cost, counting per record overstated spend by 21% in aggregate and up to
  // 3x on a single session; counting per request matched Claude Code exactly (0.000% drift over the
  // 17 self-contained sessions).
  const dir = tempDir("claude-blocks");
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000 };
  const file = claudeTranscript(dir, "s-blocks", [
    userTurn("2026-09-01T10:00:00.000Z"),
    { ...assistant("2026-09-01T10:00:05.000Z", "claude-opus-5", usage), requestId: "req_1", uuid: "u1", apiBlockIndex: 0, message: { id: "msg_1", model: "claude-opus-5", usage } },
    { ...assistant("2026-09-01T10:00:06.000Z", "claude-opus-5", usage), requestId: "req_1", uuid: "u2", apiBlockIndex: 1, message: { id: "msg_1", model: "claude-opus-5", usage } },
    { ...assistant("2026-09-01T10:00:07.000Z", "claude-opus-5", usage), requestId: "req_1", uuid: "u3", apiBlockIndex: 2, message: { id: "msg_1", model: "claude-opus-5", usage } },
    // A genuinely separate request with the same numbers IS charged again.
    { ...assistant("2026-09-01T10:10:00.000Z", "claude-opus-5", usage), requestId: "req_2", uuid: "u4", apiBlockIndex: 0, message: { id: "msg_2", model: "claude-opus-5", usage } },
  ]);

  const scan = await scanClaudeTranscript(file);
  assert.equal(scan.requests, 2, "three blocks of one response plus one more response");
  assert.equal(scan.duplicateBlocks, 2);
  const bucket = scan.buckets.find((b) => b.model === "claude-opus-5");
  assert.deepEqual(bucket.usage, {
    input_tokens: 20, cached_input_tokens: 10_000, cache_write_5m_tokens: 2_000, cache_write_1h_tokens: 0, output_tokens: 200,
  });
});

test("a record with no request identity is still counted", async () => {
  // Older transcripts carry neither requestId nor message.id. Falling back to the record's own uuid
  // keeps each one counted rather than collapsing a whole session into a single request.
  const dir = tempDir("claude-noreq");
  const file = claudeTranscript(dir, "s-noreq", [
    userTurn("2026-09-01T10:00:00.000Z"),
    { type: "assistant", timestamp: "2026-09-01T10:00:01.000Z", cwd: "/work/demo", entrypoint: "cli", uuid: "a", message: { model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 7 } } },
    { type: "assistant", timestamp: "2026-09-01T10:00:02.000Z", cwd: "/work/demo", entrypoint: "cli", uuid: "b", message: { model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 7 } } },
  ]);
  const scan = await scanClaudeTranscript(file);
  assert.equal(scan.requests, 2);
  assert.equal(scan.buckets.find((b) => b.model === "claude-opus-5").usage.output_tokens, 14);
});

// ── whose session is it ─────────────────────────────────────────────────────────────────────────
test("a gateway session is recognised by id, by parent, and by the places only the gateway runs", () => {
  const knownIds = new Set(["known-1", "root-1", "parent-1"]);
  const index = [{ dir: "/projects/app", slug: "app", channelId: "C1" }];
  const at = (session, scope = "host") => sessionAttribution(session, { knownIds, index, scope });

  assert.deepEqual(at({ sessionId: "known-1", origin: "headless" }), { owner: "gateway", reason: "session-id" });
  assert.deepEqual(at({ sessionId: "x", rootSessionId: "root-1", origin: "terminal" }), { owner: "gateway", reason: "root-session-id" });
  assert.deepEqual(at({ sessionId: "x", parentSessionId: "parent-1", origin: "desktop" }), { owner: "gateway", reason: "parent-session-id" });

  // The places argument. A headless session in a channel folder is a gateway run whose session row
  // has rotated out of `sessions`; the same session anywhere else is somebody's own script.
  assert.equal(at({ sessionId: "x", origin: "headless", cwd: "/projects/app/src" }).owner, "gateway");
  assert.equal(at({ sessionId: "x", origin: "headless", cwd: "/elsewhere" }).owner, "outside");
  // Inside a channel container nothing BUT the gateway runs an engine headlessly — interactive work
  // there arrives over SSH or the VS Code lease and stamps itself accordingly.
  assert.equal(at({ sessionId: "x", origin: "headless", cwd: "/home/agent/work" }, "container").owner, "gateway");
  assert.equal(at({ sessionId: "x", origin: "terminal", cwd: "/home/agent/work" }, "container").owner, "outside");

  // Interactive work in a channel folder is NOT the gateway — that is the whole point of the
  // feature, and the rule must not swallow it.
  assert.equal(at({ sessionId: "x", origin: "terminal", cwd: "/projects/app" }).owner, "outside");
  assert.equal(at({ sessionId: "x", origin: "vscode", cwd: "/projects/app" }).owner, "outside");
  assert.equal(at({ sessionId: "x", origin: "desktop", cwd: "/projects/app" }).reason, "desktop");
});

// ── origin labelling ────────────────────────────────────────────────────────────────────────────
test("origin names the client that drove the session, and headless is never claimed as a person", () => {
  assert.equal(claudeOriginFor("cli"), "terminal");
  assert.equal(claudeOriginFor("claude-vscode"), "vscode");
  assert.equal(claudeOriginFor("claude-desktop"), "desktop");
  assert.equal(claudeOriginFor("sdk-cli"), "headless", "the gateway's own invocation shape");
  assert.equal(claudeOriginFor("something-new"), "other");
  assert.equal(codexOriginFor("codex_exec"), "headless");
  assert.equal(codexOriginFor("codex-tui"), "terminal");
  assert.equal(codexOriginFor("Codex Desktop"), "desktop");
});

// ── de-duplication ──────────────────────────────────────────────────────────────────────────────
test("a session the gateway ran is skipped before its transcript is ever opened", async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out,
       cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status, session_id)
     VALUES(?, 'C1', 'room', 'U1', 'claude', 'claude-opus-5', 'interactive', 1, 1, 1, 0, 1, '', 'provider-reported', 'gw-session')`,
  ).run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO sessions(slug, thread_key, session_id) VALUES('room', 't1', 'bound-session')").run();

  const known = gatewaySessionIds();
  assert.ok(known.has("gw-session"), "the ledger's own session id");
  assert.ok(known.has("bound-session"), "a live thread binding, for rows written before session ids were stamped");

  const dir = tempDir("claude-dedupe");
  claudeTranscript(dir, "gw-session", [assistant("2026-09-01T10:00:00.000Z", "claude-opus-5", { input_tokens: 1, output_tokens: 1 })]);
  claudeTranscript(dir, "outside-session", [assistant("2026-09-01T10:00:00.000Z", "claude-opus-5", { input_tokens: 1, output_tokens: 1 })]);

  const scan = await scanClaudeState(dir, { skipSessions: [...known] });
  assert.deepEqual(scan.sessions.map((s) => s.sessionId), ["outside-session"]);
  assert.deepEqual(scan.skipped, ["gw-session"]);
});

test("an unchanged transcript is not re-read on the next pass", async () => {
  const dir = tempDir("claude-incremental");
  const file = claudeTranscript(dir, "s-inc", [assistant("2026-09-01T10:00:00.000Z", "claude-opus-5", { input_tokens: 1, output_tokens: 1 })]);
  const first = await scanClaudeState(dir);
  assert.equal(first.sessions.length, 1);
  const bookmark = { "s-inc": { size: first.sessions[0].size, mtimeMs: first.sessions[0].mtimeMs } };
  const second = await scanClaudeState(dir, { known: bookmark });
  assert.equal(second.sessions.length, 0);
  assert.deepEqual(second.unchanged, ["s-inc"]);
  // …but a transcript that grew is read again.
  writeFileSync(file, jsonl([assistant("2026-09-01T11:00:00.000Z", "claude-opus-5", { input_tokens: 2, output_tokens: 2 })]), { flag: "a" });
  assert.equal((await scanClaudeState(dir, { known: bookmark })).sessions.length, 1);
});

// ── Codex rollouts ──────────────────────────────────────────────────────────────────────────────
test("a Codex rollout's per-request deltas are counted once, and a replayed terminal total is not double-billed", async () => {
  const dir = tempDir("codex-state");
  const day = path.join(dir, "sessions", "2026", "09", "01");
  mkdirSync(day, { recursive: true });
  const file = path.join(day, "rollout-2026-09-01T10-00-00-abc.jsonl");
  const tokenEvent = (ts, total, last) => ({
    timestamp: ts, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 } },
  });
  writeFileSync(file, jsonl([
    { timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: "abc", session_id: "abc", cwd: "/work/demo", originator: "codex-tui", cli_version: "0.1" } },
    { timestamp: "2026-09-01T10:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1", started_at: Math.floor(Date.parse("2026-09-01T10:00:01.000Z") / 1000) } },
    { timestamp: "2026-09-01T10:00:02.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    tokenEvent("2026-09-01T10:00:03.000Z", { input_tokens: 100, output_tokens: 10 }, { input_tokens: 100, output_tokens: 10 }),
    tokenEvent("2026-09-01T10:00:04.000Z", { input_tokens: 300, output_tokens: 30 }, { input_tokens: 200, output_tokens: 20 }),
    // The CLI replays its terminal token_count verbatim; the same cumulative total must not be billed again.
    tokenEvent("2026-09-01T10:00:05.000Z", { input_tokens: 300, output_tokens: 30 }, { input_tokens: 200, output_tokens: 20 }),
    { timestamp: "2026-09-01T10:00:06.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
  ]));

  const scan = await scanCodexRollout(file);
  assert.equal(scan.sessionId, "abc");
  assert.equal(scan.origin, "terminal");
  assert.equal(scan.turns, 1);
  assert.equal(scan.requests, 2, "the replayed terminal event is the same request");
  const bucket = scan.buckets.find((b) => b.model === "gpt-5.6-sol");
  assert.equal(bucket.usage.input_tokens, 300);
  assert.equal(bucket.usage.output_tokens, 30);
});

// ── turns belong to a model, or to nothing ──────────────────────────────────────────────────────
test("a turn is folded onto the model that answered it, so the stacked Runs chart sums to its total", () => {
  const usage = (out) => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: out });
  const folded = foldTurnsIntoModels([
    // A prompt, and two models answering in the same hour — the busier one owns the turn.
    { bucket: "2026-09-01T10", model: "", requests: 0, turns: 1, usage: usage(0) },
    { bucket: "2026-09-01T10", model: "claude-haiku-4-5", requests: 1, turns: 0, usage: usage(10) },
    { bucket: "2026-09-01T10", model: "claude-opus-5", requests: 3, turns: 0, usage: usage(900) },
    // A prompt at the end of an hour whose answer landed in the next one.
    { bucket: "2026-09-01T11", model: "", requests: 0, turns: 1, usage: usage(0) },
    { bucket: "2026-09-01T12", model: "claude-opus-5", requests: 2, turns: 0, usage: usage(50) },
  ]);
  assert.ok(folded.every((row) => row.model), "no model-less row survives to be counted outside every band");
  assert.equal(folded.reduce((sum, row) => sum + row.turns, 0), 2, "both turns are kept, just moved");
  assert.equal(folded.find((r) => r.bucket === "2026-09-01T10" && r.model === "claude-opus-5").turns, 1);
  assert.equal(folded.find((r) => r.bucket === "2026-09-01T12").turns, 1);

  // A turn interrupted before its first API call spent nothing, so it is not attributed to anything.
  assert.deepEqual(foldTurnsIntoModels([{ bucket: "2026-09-01T10", model: "", requests: 0, turns: 1, usage: usage(0) }]), []);
});

// ── deploying a fix has to reprocess what the old build stored ──────────────────────────────────
test("a scanner or rate change makes the next pass re-read everything, with no operator step", async () => {
  const db = getDb();
  const { metaGet, metaSet } = await import("../src/db/index.js");

  // A gateway that has never scanned: the first pass reads everything anyway, so nothing is forced.
  db.prepare("DELETE FROM external_usage_files").run();
  metaSet("external_usage_logic", "");
  assert.equal(externalScanStaleReason(db), "");

  // A gateway holding rows written before this marker existed — i.e. by the build whose Claude
  // figures were up to 3x high. Those must NOT be trusted just because every file is bookmarked.
  db.prepare(
    "INSERT INTO external_usage_files(scope, scope_key, engine, session_id, size, mtime_ms, scanned_ms) VALUES('host', '', 'claude', 'old-build', 1, 1, 1)",
  ).run();
  assert.equal(externalScanStaleReason(db), "scanned by an earlier build");

  // Up to date.
  metaSet("external_usage_logic", externalScanFingerprint());
  assert.equal(externalScanStaleReason(db), "");

  // The scanner itself moved on.
  metaSet("external_usage_logic", "v0:0000000000000000");
  assert.equal(externalScanStaleReason(db), "scanner updated");

  // Only the rate tables moved: same logic version, different fingerprint.
  metaSet("external_usage_logic", `${externalScanFingerprint().split(":")[0]}:ffffffffffffffff`);
  assert.equal(externalScanStaleReason(db), "model rates changed");

  // A pass acts on it: the bookmarks go once, and the fingerprint is stamped so a restart or a
  // truncated pass continues draining the backlog instead of starting it over.
  const summary = await scanExternalUsage({ includeContainers: false, limit: 1 });
  assert.equal(summary.reprocessing, "model rates changed");
  assert.equal(metaGet("external_usage_logic"), externalScanFingerprint());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM external_usage_files WHERE session_id = 'old-build'").get().c, 0);
  assert.equal((await scanExternalUsage({ includeContainers: false, limit: 1 })).reprocessing, "", "the next pass is ordinary again");
});

// ── persistence, attribution and the dashboard ──────────────────────────────────────────────────
test("outside work inside a channel's folder is charged to that channel; work elsewhere is not", () => {
  // Longest match wins, so a nested channel folder is never claimed by the one above it.
  const index = [
    { dir: "/projects/app", slug: "inner", channelId: "C_INNER" },
    { dir: "/projects", slug: "outer", channelId: "C_OUTER" },
  ];
  assert.equal(matchWorkdir("/projects/app/src", index).slug, "inner");
  assert.equal(matchWorkdir("/projects/app", index).slug, "inner");
  assert.equal(matchWorkdir("/projects/other", index).slug, "outer");
  assert.equal(matchWorkdir("/projects-elsewhere", index), null, "a prefix is not a parent directory");
  assert.equal(matchWorkdir("/somewhere/else", index), null);
  assert.equal(matchWorkdir("", index), null);
});

test("the work-dir index covers every folder a channel has run in, longest first", () => {
  const index = buildWorkdirIndex([
    // A custom folder that today's containment rules would REFUSE is still somewhere the gateway
    // has run. Dropping it would reclassify that channel's whole history as outside work.
    { channelId: "C1", slug: "one", meta: { workDir: "/somewhere/off/the/allowed/root" } },
    { channelId: "C2", slug: "two", meta: {} },
    { slug: "", meta: {} }, // no slug: nothing to resolve
  ]);
  assert.ok(index.some((e) => e.dir === "/somewhere/off/the/allowed/root" && e.slug === "one"));
  // Each channel also contributes its default workspace folder and its clean-mode workspace.
  assert.ok(index.filter((e) => e.slug === "one").length >= 2);
  assert.ok(index.filter((e) => e.slug === "two").length >= 2);
  assert.ok(index.every((entry) => path.isAbsolute(entry.dir) && entry.slug));
  assert.deepEqual([...index].sort((a, b) => b.dir.length - a.dir.length).map((e) => e.dir), index.map((e) => e.dir));
});

test("the tracking floor keeps pre-cutoff hours out, and the dashboard reports what survives", () => {
  const db = getDb();
  db.prepare("DELETE FROM external_usage").run();
  const nowMs = Date.now();
  const bucketAt = (offsetHours) => new Date(nowMs - offsetHours * 3_600_000).toISOString().slice(0, 13);
  const sinceMs = nowMs - 3 * 3_600_000;
  saveScopeSessions(db, {
    scope: "host",
    scopeKey: "",
    engine: "claude",
    index: [],
    sinceMs,
    now: nowMs,
    sessions: [{
      sessionId: "outside-1",
      cwd: "/work/demo",
      origin: "vscode",
      size: 10,
      mtimeMs: nowMs,
      buckets: [
        // Before the floor: unverifiable, so it must not be counted at all.
        { bucket: bucketAt(10), model: "claude-opus-5", requests: 1, turns: 1, usage: { input_tokens: 1e6, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0 } },
        { bucket: bucketAt(1), model: "claude-opus-5", requests: 2, turns: 1, usage: { input_tokens: 1e6, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0 } },
      ],
    }],
  });

  const rows = db.prepare("SELECT bucket, origin, cost_usd, tokens_in FROM external_usage").all();
  assert.equal(rows.length, 1, "only the hour after the floor survives");
  assert.equal(rows[0].origin, "vscode");
  assert.equal(rows[0].tokens_in, 1e6);
  assert.ok(rows[0].cost_usd > 0, "priced from the Claude rate table");

  const all = usageDashboard({ range: "today" });
  const external = usageDashboard({ range: "today", source: "external" });
  const gateway = usageDashboard({ range: "today", source: "gateway" });
  assert.equal(external.totals.externalCost, rows[0].cost_usd);
  assert.equal(gateway.totals.externalCost, 0, "the gateway-only scope never mixes outside usage in");
  assert.equal(
    Number((gateway.totals.cost + external.totals.cost).toFixed(4)),
    all.totals.cost,
    "the two scopes partition the combined total",
  );
  assert.ok(all.origins.some((o) => o.origin === "vscode"));
  assert.ok(all.origins.some((o) => o.origin === "gateway"));
  // Outside usage is stacked by model exactly like a gateway run.
  assert.ok(external.models.some((m) => m.model === "claude-opus-5" && m.externalRuns > 0));
});

test("a container scope is read through the runtime, and its rows are attributed to that channel", async () => {
  const db = getDb();
  db.prepare("DELETE FROM external_usage WHERE scope = 'container'").run();
  const asked = [];
  // The runtime's read-only usage inspection is the ONLY door into a channel's HOME volume; the
  // daemon cannot open it directly. A fake one proves the scan goes through that seam — and, by
  // never offering ensureUp, that the scan cannot start a container to get its answer.
  const target = {
    backend: "container",
    container: { name: "cg-test", claudeConfigDir: "/home/agent/.claude", codexHome: "/home/agent/.codex" },
    runtime: {
      async inspectUsage(_target, { args }) {
        asked.push(args);
        if (args.operation !== "scan") return { sessions: [], unchanged: [], skipped: [], total: 0 };
        return {
          sessions: [{
            sessionId: "in-container-1",
            cwd: "/home/agent/work",
            origin: "terminal",
            size: 1,
            mtimeMs: Date.now(),
            buckets: [{
              bucket: new Date().toISOString().slice(0, 13),
              model: "claude-opus-5",
              requests: 3,
              turns: 1,
              usage: { input_tokens: 1_000, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 100 },
            }],
          }],
          unchanged: [],
          skipped: [],
          total: 1,
        };
      },
    },
  };

  const summary = await scanExternalUsage({ scopes: [{ scope: "container", scopeKey: "dev-room", target }], limit: 10 });
  assert.equal(summary.scopes.length, 1);
  assert.deepEqual(asked.map((a) => a.stateDir).sort(), ["/home/agent/.claude", "/home/agent/.codex"]);
  assert.ok(asked.every((a) => Array.isArray(a.skipSessions)), "the channel's own gateway sessions are excluded inside the container too");

  const row = db.prepare("SELECT * FROM external_usage WHERE scope = 'container' AND session_id = 'in-container-1'").get();
  assert.ok(row, "the container's outside session is recorded");
  assert.equal(row.slug, "dev-room", "an unmatched cwd inside a container still belongs to that channel");
  assert.equal(row.origin, "terminal");
  assert.ok(row.cost_usd > 0);
});

test("a pass reads all history by default and reports how it attributed what it read", async () => {
  const summary = await scanExternalUsage({ includeContainers: false, limit: 5 });
  assert.equal(summary.since, "", "no window is applied unless one is asked for");
  assert.ok(summary.trackingStartedAt, "the first pass records when tracking began, for the Overview to caption");
  assert.ok(summary.attributed && typeof summary.attributed === "object", "every pass says what it recognised as the gateway's own");
  assert.ok(Array.isArray(summary.errors));
  assert.ok(summary.scopes.some((s) => s.scope === "host"));
});
