import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setAssistantStatus, startProgress } = await import("../src/slack/app.js");
const { progressFromCodexEvent } = await import("../src/engines/codex.js");

test("local transcription can use Slack's native compact and prominent status fields", () => {
  const calls = [];
  const client = { apiCall: async (method, payload) => calls.push([method, payload]) };
  setAssistantStatus(client, "C1", "111.222", "is transcribing voice locally…", ["Transcribing voice locally…"]);
  assert.deepEqual(calls, [["assistant.threads.setStatus", {
    channel_id: "C1",
    thread_ts: "111.222",
    status: "is transcribing voice locally…",
    loading_messages: ["Transcribing voice locally…"],
  }]]);
});

test("assistant loading messages are clipped to Slack's 50-character limit", async () => {
  let sent;
  const client = {
    apiCall: async (_method, payload) => {
      sent = payload;
      if (payload.loading_messages.some((message) => message.length > 50)) {
        throw new Error("must be less than 51 characters");
      }
    },
  };

  const accepted = await setAssistantStatus(client, "C_LIMIT", "111.223", "is thinking…", [
    "gpt-5.6-sol · Thinking — tracing every recovery edge across the gateway",
  ]);

  assert.equal(accepted, true, "the normalized request should be accepted by Slack");
  assert.equal(sent.loading_messages[0].length, 50);
  assert.match(sent.loading_messages[0], /…$/);
});

test("assistant loading-message clipping never splits a surrogate pair", async () => {
  let sent;
  const client = { apiCall: async (_method, payload) => { sent = payload; } };

  await setAssistantStatus(client, "C_EMOJI", "111.224", "is thinking…", [
    `${"A".repeat(48)}😀tail`,
  ]);

  assert.equal(sent.loading_messages[0], `${"A".repeat(48)}…`);
  assert.equal(sent.loading_messages[0].length, 49);
});

test("assistant loading-message rotation stays within Slack's ten-message limit", async () => {
  let sent;
  const client = {
    apiCall: async (_method, payload) => {
      sent = payload;
      if (payload.loading_messages.length > 10) throw new Error("too many loading messages");
    },
  };

  const accepted = await setAssistantStatus(
    client,
    "C_ROTATION",
    "111.225",
    "is thinking…",
    Array.from({ length: 12 }, (_, index) => `Phase ${index + 1}`),
  );

  assert.equal(accepted, true);
  assert.equal(sent.loading_messages.length, 10);
});

// Pull every task_update chunk (the native tool/plan card rows) out of the recorded append/stop
// payloads, in call order — the timeline streams them as { chunks: [{ type: "task_update", ... }] }.
function taskUpdates(calls) {
  const out = [];
  for (const c of calls) {
    if (c[0] !== "append" && c[0] !== "stopStream") continue;
    for (const ch of c[1]?.chunks || []) if (ch.type === "task_update") out.push(ch);
  }
  return out;
}

function planUpdates(calls) {
  const out = [];
  for (const call of calls) {
    if (call[0] !== "append" && call[0] !== "stopStream") continue;
    for (const chunk of call[1]?.chunks || []) if (chunk.type === "plan_update") out.push(chunk);
  }
  return out;
}

function terminalTaskUpdates(calls) {
  const stop = [...calls].reverse().find((call) =>
    call[0] === "stopStream" && call[1]?.chunks?.some((chunk) => chunk.type === "task_update"));
  return (stop?.[1]?.chunks || []).filter((chunk) => chunk.type === "task_update");
}

function heartbeatUpdates(calls) {
  return taskUpdates(calls).filter((chunk) => chunk.id.startsWith("heartbeat-"));
}

// What Slack actually SHOWS after a stream of task chunks: a row's title/status are replaced in
// place, while its rich `details`/`output` are APPENDED to whatever that row already renders.
// Asserting on this reconstruction is what proves a stage's output appears exactly once instead
// of two or three times (published live, again on the status flip, again in the terminal seal).
function renderedRows(calls) {
  const rendered = new Map();
  for (const chunk of taskUpdates(calls)) {
    const row = rendered.get(chunk.id) || { id: chunk.id, details: "", output: "" };
    if (chunk.title !== undefined) row.title = chunk.title;
    if (chunk.status !== undefined) row.status = chunk.status;
    if (chunk.details !== undefined) row.details += chunk.details;
    if (chunk.output !== undefined) row.output += chunk.output;
    if (chunk.sources !== undefined) row.sources = chunk.sources;
    rendered.set(chunk.id, row);
  }
  return rendered;
}

// Some card tests model an ordinary channel thread where Slack refuses
// assistant.threads.setStatus. The toolbox is independent of that temporary status surface and
// must remain live/persistent either way. Unique channel ids keep the module-level "setStatus
// refused for this thread" cache from leaking between tests.
let cardChannelSeq = 0;
const cardChannel = () => `C_CARD_${++cardChannelSeq}`;
const refuseStatus = (calls = null) => async (method, payload) => {
  calls?.push(["apiCall", method, payload]);
  if (method === "assistant.threads.setStatus") throw new Error("invalid_thread");
};
// Drain a status round-trip where a test needs to inspect its effects.
const cardReady = () => new Promise((resolve) => setImmediate(resolve));

test("stream progress keeps a persistent toolbox while assistant status stays temporary", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async (method, payload) => calls.push(["apiCall", method, payload]),
    chatStream: (payload) => {
      calls.push(["chatStream", payload]);
      return streamer;
    },
    chat: {
      postMessage: async (payload) => calls.push(["postMessage", payload]),
      update: async (payload) => calls.push(["update", payload]),
    },
  };

  const progress = startProgress("stream", client, "C123", "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
    dir: null,
  });

  progress.onRuntimeResolved({ engine: "claude", model: "claude-opus-4-8[1m]" });
  await cardReady(); // one status write is in flight at a time; drain it before the next phase
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  await cardReady();
  progress.onDelta("Final answer.");
  await progress.finalize({
    content: "Final answer.",
    durationMs: 1000,
    usage: { input_tokens: 10, output_tokens: 2 },
  });

  assert.equal(progress.ownsFinal, true);
  const streamStart = calls.find((c) => c[0] === "chatStream");
  assert.ok(streamStart, "native chat stream should start");
  assert.equal(streamStart[1].task_display_mode, "plan", "tool/plan rows group into one card via plan display mode");
  assert.ok(calls.some((c) => c[0] === "append"), "answer text should stream through append");
  assert.ok(calls.some((c) => c[0] === "stopStream"), "native stream should be finalized");
  assert.ok(
    calls.some((c) => c[0] === "apiCall" && c[1] === "assistant.threads.setStatus" && /using Bash/.test(c[2].status)),
    "tool progress should use native assistant status"
  );
  assert.ok(
    calls.some((c) => c[0] === "apiCall" && c[1] === "assistant.threads.setStatus" && c[2].status === "is gathering information… · Opus 4.8 1M"),
    "the compact activity status should identify the resolved model"
  );
  assert.ok(
    calls.some((c) =>
      c[0] === "apiCall" &&
      c[1] === "assistant.threads.setStatus" &&
      c[2].loading_messages?.[0] === "Opus 4.8 1M · Gathering information…"
    ),
    "the prominent loading indicator should identify the resolved model"
  );
  assert.ok(
    calls.some((c) => c[0] === "apiCall" && c[1] === "assistant.threads.setStatus" && c[2].status === "is using Bash(npm test)… · Opus 4.8 1M"),
    "later activity phases should retain the model"
  );
  assert.equal(calls.some((c) => c[0] === "postMessage"), false, "stream mode should not post activity log");
  assert.equal(calls.some((c) => c[0] === "update"), false, "stream mode should not update activity log");

  // The two native surfaces have different lifetimes: tool history stays in the finalized
  // message, while the assistant status is explicitly cleared when the run ends.
  const toolbox = new Map(terminalTaskUpdates(calls).map((row) => [row.id, row]));
  const bash = [...toolbox.values()].find((row) => /Bash\(npm test\)/.test(row.title));
  assert.ok(bash, "an assistant thread must retain the tool row in its message toolbox");
  assert.equal(bash.status, "complete", "the persistent tool row must be terminal at completion");
  assert.equal(
    calls.some((c) => c[0] === "append" && /details in the card above/i.test(c[1]?.markdown_text || "")),
    false,
    "the persistent toolbox should not add a duplicate text recap"
  );
  const statuses = calls
    .filter((c) => c[0] === "apiCall" && c[1] === "assistant.threads.setStatus")
    .map((c) => c[2].status);
  assert.equal(statuses.at(-1), "", "the temporary assistant status must clear after finalization");
});

test("live progress is posted in a separate first message and never splits the answer", async () => {
  const calls = [];
  let sequence = 0;
  const client = {
    apiCall: async () => {},
    chatStream: () => {
      const id = `stream-${++sequence}`;
      const stream = {
        id,
        ts: undefined,
        append: async (payload) => {
          stream.ts ??= `111.22${sequence}`;
          calls.push(["append", id, payload]);
        },
        stop: async (payload) => calls.push(["stopStream", id, payload]),
      };
      return stream;
    },
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_ORDER", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onEvent({ kind: "tool_use", id: "tool-1", name: "Read", target: "message.js" });
  progress.onDelta("The uninterrupted answer begins ");
  progress.onEvent({ kind: "thinking", summary: "checking the result" });
  progress.onDelta("and ends here.");
  await progress.finalize({ content: "The uninterrupted answer begins and ends here." });

  const cardWrites = calls.filter((call) => call[0] === "append" && call[2]?.chunks);
  const answerWrites = calls.filter((call) => call[0] === "append" && call[2]?.markdown_text);
  assert.ok(cardWrites.length > 0, "the progress card stays live during the run");
  assert.equal(cardWrites[0][1], "stream-1", "the first helper is the dedicated progress stream");
  assert.equal(answerWrites[0][1], "stream-2", "the second helper is the dedicated answer stream");
  assert.ok(calls.indexOf(cardWrites[0]) < calls.indexOf(answerWrites[0]), "the card is posted before answer text");
  assert.equal(answerWrites.some((call) => call[2]?.chunks), false, "task chunks never enter the answer message");
  assert.equal(cardWrites.some((call) => call[2]?.markdown_text), false, "answer Markdown never enters the card message");
  assert.equal(answerWrites.map((call) => call[2].markdown_text).join(""), "The uninterrupted answer begins and ends here.\n\n<@U1>");
});

test("persistent toolbox appends immediately restore the temporary assistant status", async () => {
  const calls = [];
  let visibleStatus = "";
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => {
      calls.push(["append", payload]);
      // Slack clears assistant.threads status whenever this app writes in the thread.
      visibleStatus = "";
    },
    stop: async () => {},
  };
  const client = {
    apiCall: async (method, payload) => {
      calls.push(["apiCall", method, payload]);
      visibleStatus = payload.status;
    },
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, "C_STATUS_RESTORE", "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-sol" });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(calls.some((call) => call[0] === "append" && call[1]?.chunks), "the durable toolbox wrote its tool row");
  assert.match(visibleStatus, /using Bash\(npm test\)/,
    "the live status must be reasserted after Slack clears it for the toolbox append");

  await progress.stop();
  assert.equal(visibleStatus, "", "the temporary status still disappears at the terminal boundary");
});

test("tool completion advances the live status and terminal toolbox immediately", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async (method, payload) => calls.push(["apiCall", method, payload]),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_TOOL_END", "111.222", {
    authorId: "U1",
    teamId: "T1",
  });

  progress.onEvent({ kind: "tool_use", id: "tool-1", name: "Bash", target: "npm test" });
  progress.onEvent({ kind: "tool_result", id: "different-tool", name: "Read", target: "other.js", status: "completed" });
  await cardReady();
  assert.equal(
    taskUpdates(calls).filter((candidate) => /Bash\(npm test\)/.test(candidate.title)).at(-1)?.status,
    "in_progress",
    "a stale result id must not close whichever unrelated tool happens to be active",
  );
  progress.onEvent({ kind: "tool_result", id: "tool-1", name: "Bash", target: "npm test", status: "completed" });
  await cardReady();
  await cardReady();

  const statuses = calls
    .filter((call) => call[0] === "apiCall" && call[1] === "assistant.threads.setStatus")
    .map((call) => call[2].status);
  assert.ok(statuses.some((status) => /finished Bash\(npm test\)/.test(status)),
    "the temporary surface should stop claiming a completed tool is still running");

  await progress.finalize({ content: "Tests passed." });
  const row = terminalTaskUpdates(calls).find((candidate) => /Bash\(npm test\)/.test(candidate.title));
  assert.equal(row?.status, "complete", "the durable row should close as soon as the result arrives");
  assert.equal(statuses.includes(""), false, "precondition: terminal clear happens only during finalize");
  assert.equal(
    calls.filter((call) => call[0] === "apiCall" && call[1] === "assistant.threads.setStatus").at(-1)[2].status,
    "",
  );
});

// Slack renders the toolbox header from the AGGREGATE row statuses: a single row flagged `error`
// collapses the entire card to a red "Something went wrong" banner, even when the turn recovered
// and answered. A grep that matched nothing or a sed on a path that moved is not a failed turn, so
// a tool failure is reported in its own row's label and nowhere else.
test("a failed tool labels its own row without flagging the whole card as an error", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_TOOL_FAIL", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onEvent({ kind: "tool_use", id: "tool-1", name: "Bash", target: "sed -n '1,40p' missing.js" });
  progress.onEvent({ kind: "tool_result", id: "tool-1", name: "Bash", target: "sed -n '1,40p' missing.js", status: "failed" });
  progress.onEvent({ kind: "tool_use", id: "tool-2", name: "Read", target: "app.js" });
  progress.onEvent({ kind: "tool_result", id: "tool-2", name: "Read", target: "app.js", status: "completed" });
  await cardReady();
  await progress.finalize({ content: "Answered anyway." });

  const rows = terminalTaskUpdates(calls).filter((row) => row.id.startsWith("tool-"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.status), ["complete", "complete"],
    "no row may carry `error`, which Slack would render as a card-wide failure header");
  assert.match(rows[0].title, /^⚠️ .*· failed$/, "the failure stays visible on the row that actually failed");
  assert.doesNotMatch(rows[1].title, /failed/, "a healthy sibling row is untouched");
  assert.equal(taskUpdates(calls).some((row) => row.status === "error"), false,
    "not even a transient append may flag an error status");
});

// A dead stream is a delivery accident, not the run's verdict. Slack ends a stream on its own
// (an append delayed past its window by rate limiting, an age cap) and then renders that message
// as a bare "Something went wrong" — which is how a recovered turn came to sit under a red error
// banner while its correct answer was posted right below. The card state is still perfectly good,
// so it is republished into a fresh stream and the stranded copy is removed.
function deadStreamError() {
  return Object.assign(new Error("message_not_in_streaming_state"), {
    data: { error: "message_not_in_streaming_state" },
  });
}

test("a card stream Slack ends mid-run is republished instead of stranded as 'Something went wrong'", async () => {
  const calls = [];
  const streams = [];
  const client = {
    apiCall: refuseStatus(),
    chatStream: (args) => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00020${streams.length + 1}`,
        // Slack ends the FIRST card stream after its opening append; everything sent to it later
        // fails, exactly as the live gateway saw under heavy chat.appendStream rate limiting.
        append: async (payload) => {
          calls.push(["append", payload, id]);
          if (id === "stream-1" && calls.filter((c) => c[0] === "append" && c[2] === "stream-1").length > 1) {
            throw deadStreamError();
          }
        },
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      calls.push(["chatStream", args, id]);
      return stream;
    },
    chat: {
      postMessage: async () => {},
      update: async () => {},
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onEvent({ kind: "tool_use", id: "tool-1", name: "Bash", target: "cat missing.txt" });
  await cardReady();
  // The tool the model went on to handle: the harness reports it as an error, so the row is
  // labelled — and that alone must never cost the turn its card.
  progress.onEvent({ kind: "tool_result", id: "tool-1", name: "Bash", target: "cat missing.txt", status: "failed" });
  progress.onEvent({ kind: "tool_use", id: "tool-2", name: "Read", target: "notes.md" });
  progress.onEvent({ kind: "tool_result", id: "tool-2", name: "Read", target: "notes.md", status: "completed" });
  await cardReady();
  await cardReady();
  await progress.finalize({ content: "Answered anyway." });

  const cardStreams = [...new Set(calls.filter((call) => call[0] === "append" || call[0] === "stopStream")
    .filter((call) => (call[1]?.chunks || []).length)
    .map((call) => call[2]))];
  assert.ok(cardStreams.includes("stream-2"),
    "a card whose stream Slack ended must be republished, not abandoned mid-run");
  const replacement = calls
    .filter((call) => call[2] === "stream-2")
    .flatMap((call) => call[1]?.chunks || [])
    .filter((chunk) => chunk.type === "task_update");
  assert.ok(replacement.some((row) => /^⚠️ Bash\(cat missing\.txt\).*· failed$/.test(row.title)),
    "the replacement carries the full history, warning row included");
  assert.ok(replacement.some((row) => /Read\(notes\.md\)/.test(row.title)),
    "rows that never reached the dead message are recovered too");
  assert.equal(replacement.some((row) => row.status === "error"), false,
    "a handled tool failure is a row label, never a card-wide error state");
  assert.deepEqual(calls.filter((call) => call[0] === "delete").map((call) => call[1].ts), [streams[0].ts],
    "the stranded message renders an error banner and nothing else, so it must not survive");
  const deleteAt = calls.findIndex((call) => call[0] === "delete");
  const replacementAt = calls.findIndex((call) => call[2] === "stream-2" && call[0] === "append");
  assert.ok(replacementAt >= 0 && deleteAt > replacementAt,
    "the replacement is made durable before the stranded copy is removed");
  const sealed = calls.find((call) => call[0] === "stopStream" && call[2] === "stream-2");
  assert.ok((sealed?.[1]?.chunks || []).some((chunk) => chunk.type === "task_update"),
    "the replacement is sealed with the finished toolbox");
});

test("a terminal seal that finds the stream already gone republishes the finished toolbox", async () => {
  const calls = [];
  const streams = [];
  const client = {
    apiCall: refuseStatus(),
    chatStream: (args) => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00030${streams.length + 1}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => {
          calls.push(["stopStream", payload, id]);
          if (id === "stream-1") throw deadStreamError();
        },
      };
      streams.push(stream);
      calls.push(["chatStream", args, id]);
      return stream;
    },
    chat: {
      postMessage: async () => {},
      update: async () => {},
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onEvent({ kind: "tool_use", id: "tool-1", name: "Bash", target: "npm test" });
  progress.onEvent({ kind: "tool_result", id: "tool-1", name: "Bash", target: "npm test", status: "failed" });
  await cardReady();
  await progress.finalize({ content: "Recovered and answered." });

  const republished = calls.find((call) =>
    call[0] === "stopStream" && call[2] !== "stream-1" && (call[1]?.chunks || []).some((chunk) => chunk.type === "task_update"));
  assert.ok(republished, "a toolbox whose seal found a dead stream is published to a live one");
  assert.ok(republished[1].chunks.some((chunk) => /^⚠️ Bash\(npm test\).*· failed$/.test(chunk.title)),
    "the republished card keeps the warning on the row that actually failed");
  assert.equal(republished[1].chunks.some((chunk) => chunk.status === "error"), false,
    "and still reports no card-level failure for a turn that answered");
  assert.deepEqual(calls.filter((call) => call[0] === "delete").map((call) => call[1].ts), [streams[0].ts],
    "the stranded 'Something went wrong' copy is removed");
});

// The other half of the contract: the card CAN report a failure — when the agent itself declares
// the stage failed through `report_progress`. Suppressing that too would trade one wrong signal
// for another.
test("a stage the agent itself declares failed keeps its error status", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000400",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onEvent({
    kind: "report_progress",
    title: "Migration",
    steps: [{ id: "verify", title: "Verify the migration", status: "error", details: "", output: "", sources: [] }],
  });
  await cardReady();
  await progress.finalize({ content: "The migration could not be verified." });

  assert.equal(terminalTaskUpdates(calls).find((row) => row.id === "report-verify")?.status, "error",
    "`error` stays available for a stage the agent declares failed");
});

test("answer-stream appends restore the temporary status on a bounded cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let visibleStatus = "";
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => {
      calls.push(["append", payload]);
      // Slack removes the native assistant status after any app-authored message activity.
      visibleStatus = "";
    },
    stop: async () => {},
  };
  const client = {
    apiCall: async (method, payload) => {
      calls.push(["apiCall", method, payload]);
      visibleStatus = payload.status;
    },
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, "C_STATUS_DELTA", "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-sol" });
  await cardReady();

  progress.onDelta("The answer is streaming.");
  await cardReady();
  assert.equal(visibleStatus, "", "the stream append models Slack clearing the status");

  t.mock.timers.tick(1_499);
  await cardReady();
  assert.equal(visibleStatus, "", "answer tokens must not trigger an unbounded status write per append");

  t.mock.timers.tick(1);
  await cardReady();
  assert.match(visibleStatus, /putting it all together/, "the current phase should return promptly while the answer streams");

  await progress.stop();
  assert.equal(visibleStatus, "", "the delayed restoration cannot outlive the run");
});

test("assistant status writes are serialized so the terminal clear is last", async () => {
  const pending = [];
  const applied = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    apiCall: (_method, payload) => new Promise((resolve) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push(() => {
        applied.push(payload.status);
        inFlight -= 1;
        resolve();
      });
    }),
    chatStream: () => ({ ts: "1720000000.000100", append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, "C_STATUS_ORDER", "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onRuntimeResolved({ engine: "claude", model: "claude-opus-4-8" });
  progress.onEvent({ kind: "tool_use", name: "Read", target: "progress.js" });
  let stopped = false;
  const stopPromise = progress.stop().then(() => { stopped = true; });

  // Drain whichever calls the controller chose to retain. A serialized controller exposes only
  // one unresolved Slack request at a time; stop() must eventually enqueue the clear behind it.
  for (let turns = 0; turns < 20 && !stopped; turns += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    pending.shift()?.();
  }
  await stopPromise;

  assert.equal(maxInFlight, 1, "status requests must not race or apply out of order");
  assert.equal(applied.at(-1), "", "no stale activity update may land after the terminal clear");
});

test("an assistant-thread status line carries thinking summaries and the loading line mirrors the activity", async () => {
  const calls = [];
  const client = {
    apiCall: async (method, payload) => calls.push([method, payload]),
    chatStream: () => ({ append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {} },
  };
  const progress = startProgress("stream", client, "C_ASSIST_THINK", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onRuntimeResolved({ engine: "claude", model: "claude-opus-4-8" });
  progress.onEvent({ kind: "thinking", summary: "weighing the two schema options" });
  await cardReady();
  await progress.stop();

  const statusCalls = calls.filter((c) => c[0] === "assistant.threads.setStatus");
  assert.ok(
    statusCalls.some((c) => c[1].status === "is thinking — weighing the two schema options · Opus 4.8"),
    "the status should carry the reasoning gist"
  );
  assert.ok(
    statusCalls.some((c) => (c[1].loading_messages || []).includes("Opus 4.8 · Thinking — weighing the two schema opt…")),
    "the prominent loading line should mirror the live activity, model first"
  );
  assert.equal(statusCalls.at(-1)[1].status, "", "stopping the run clears the temporary status");
});

test("an ordinary channel thread keeps the live toolbox when assistant status is unavailable", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(calls),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });

  // Fired before the failed status round-trip resolves: the independent toolbox is already live.
  progress.onEvent({ kind: "tool_use", name: "Read", target: "early.js" });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("Answer.");
  await progress.finalize({ content: "Answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const finalById = new Map(terminalTaskUpdates(calls).map((row) => [row.id, row]));
  const read = [...finalById.values()].find((row) => /Read\(early\.js\)/.test(row.title));
  const bash = [...finalById.values()].find((row) => /Bash/.test(row.title));
  assert.ok(read, "the pre-resolution tool row is retained in the toolbox");
  assert.ok(bash, "later tool rows stream live");
  assert.equal(read.status, "complete");
  assert.equal(bash.status, "complete");
});

test("Codex command rows are sealed into the persistent terminal toolbox", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-sol" });
  const mapped = progressFromCodexEvent({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test" } });
  assert.deepEqual(mapped, { event: { kind: "tool_use", id: "cmd-1", name: "npm test" } });
  progress.onEvent(mapped.event);
  progress.onDelta("Codex answer.");
  await progress.finalize({ content: "Codex answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const codexToolbox = terminalTaskUpdates(calls);
  const row = codexToolbox.find((candidate) => candidate.title === "npm test");
  assert.ok(row, "the mapped Codex command must survive in Slack history");
  assert.equal(row.status, "complete");
});

test("stream progress updates its model label when the runtime falls back to Codex", async () => {
  const calls = [];
  const client = {
    apiCall: async (method, payload) => calls.push([method, payload]),
    chatStream: () => ({ append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {} },
  };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onRuntimeResolved({ engine: "claude", model: "claude-sonnet-4-6" });
  await cardReady();
  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.4" });
  await cardReady();
  await progress.stop();

  const statuses = calls.filter((c) => c[0] === "assistant.threads.setStatus").map((c) => c[1].status);
  const loadingMessages = calls.filter((c) => c[0] === "assistant.threads.setStatus").flatMap((c) => c[1].loading_messages || []);
  assert.ok(statuses.includes("is gathering information… · Sonnet 4.6"));
  assert.ok(statuses.includes("is gathering information… · gpt-5.4"));
  assert.ok(loadingMessages.includes("Sonnet 4.6 · Gathering information…"));
  assert.ok(loadingMessages.includes("gpt-5.4 · Gathering information…"));
});

test("completed-run footer carries authorized-user Settings beside Files and Secrets", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]) },
  };
  const progress = startProgress("stream", client, "C_FILES", "111.222", {
    isDM: false,
    mayUseSettings: true,
    authorId: "U_REQUESTER",
    teamId: "T1",
    dir: null,
  });

  progress.onDelta("Done.");
  await progress.finalize({
    content: "Done.",
    cwd: "/tmp/channel",
    sessionId: "session-1",
    engine: "codex",
    durationMs: 5,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const stop = calls.find((call) => call[0] === "stopStream");
  assert.deepEqual(stop[1].blocks.map((block) => block.type), ["context", "actions"]);
  const buttons = stop[1].blocks[1].elements;
  assert.deepEqual(buttons.map((button) => button.text.text), ["💻", "📂", "🔑", "⚙️ Settings"]);
  const settings = buttons.find((button) => button.action_id === "cg_channel_settings");
  assert.deepEqual(JSON.parse(settings.value), { o: "open", c: "C_FILES", t: "111.222", u: "U_REQUESTER" });
  const files = buttons.find((button) => button.text.text === "📂");
  assert.equal(files.action_id, "cg_channel_files");
  assert.equal(files.accessibility_label, "Open channel files");
  assert.deepEqual(JSON.parse(files.value), { o: "open", c: "C_FILES", t: "111.222", u: "U_REQUESTER" });
  const secrets = buttons.find((button) => button.text.text === "🔑");
  assert.equal(secrets.action_id, "cg_channel_secrets");
  assert.equal(secrets.accessibility_label, "Manage channel secrets");
  assert.deepEqual(JSON.parse(secrets.value), { o: "open", c: "C_FILES", t: "111.222", u: "U_REQUESTER" });
});

test("completed-run footer adds one direct-preview button per referenced workspace file", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-review-files-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "review spec.md"), "# Review\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const streamer = { ts: "1.1", append: async () => {}, stop: async (payload) => calls.push(payload) };
  const client = { apiCall: async () => {}, chatStream: () => streamer, chat: { postMessage: async () => {} } };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onDelta("Done.");
  await progress.finalize({
    content: `Review [the specification](${root}/docs/review%20spec.md) and \`${root}/docs/review spec.md\`.`,
    cwd: root,
    durationMs: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const buttons = calls[0].blocks.at(-1).elements;
  assert.deepEqual(buttons.map((button) => button.text.text), ["📂", "🔑", "📄 review spec.md"]);
  assert.deepEqual(JSON.parse(buttons[2].value), { o: "open_file", c: "C1", t: "111.222", u: "U1", p: "docs/review spec.md" });
});

test("invalid footer blocks finalize the existing stream without duplicating the answer", async () => {
  const calls = [];
  let stopAttempts = 0;
  let streamCount = 0;
  const client = {
    apiCall: async () => {},
    chatStream: () => {
      const isAnswer = ++streamCount === 2;
      return {
        ts: `1720000000.00010${streamCount}`,
        append: async (payload) => calls.push(["append", payload]),
        stop: async (payload) => {
          if (!isAnswer) {
            calls.push(["progressStop", payload]);
            return;
          }
          stopAttempts += 1;
          calls.push(["stopStream", payload]);
          if (stopAttempts === 1) {
            throw Object.assign(new Error("An API error occurred: invalid_blocks"), {
              data: { error: "invalid_blocks" },
            });
          }
        },
      };
    },
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]) },
  };
  const progress = startProgress("stream", client, "C_FOOTER_RECOVERY", "111.222", {
    authorId: "U1",
    teamId: "T1",
    dir: null,
  });

  progress.onEvent({ kind: "tool_use", name: "Read", target: "progress.js" });
  await progress.finalize({ content: "Completed answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const stops = calls.filter((call) => call[0] === "stopStream");
  assert.equal(stops.length, 2);
  assert.ok(stops[0][1]?.blocks, "the normal footer is attempted first");
  assert.match(stops[0][1].markdown_text, /Completed answer/,
    "a tool-only turn buffers its answer in the first terminal request");
  assert.equal(stops[1][1]?.blocks, undefined, "the retry drops the rejected footer blocks");
  assert.equal(stops[1][1]?.markdown_text, undefined,
    "the retry must not append markdown already retained in ChatStreamer's buffer");
  const recoveredTool = calls.find((call) => call[0] === "progressStop")?.[1]?.chunks
    ?.find((chunk) => chunk.type === "task_update" && /Read/.test(chunk.title));
  assert.equal(recoveredTool?.status, "complete", "the separate progress stream seals the durable toolbox snapshot");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false,
    "the authoritative streamed answer must not be duplicated through classic fallback");
});

test("task timeline: tool rows flip in_progress→complete and a TodoWrite plan maps its statuses", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(calls),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U1",
    teamId: "T1",
    dir: null,
  });
  await cardReady();

  // A plan snapshot, then two tools, then the answer starts.
  progress.onEvent({ kind: "todos", items: [
    { content: "Read the channel history", status: "in_progress" },
    { content: "Write the summary", status: "pending" },
  ] });
  progress.onEvent({ kind: "tool_use", name: "Read", target: "run.js" });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  // Plan advances: first item done, second now running.
  progress.onEvent({ kind: "todos", items: [
    { content: "Read the channel history", status: "completed" },
    { content: "Write the summary", status: "in_progress" },
  ] });
  progress.onDelta("Here is the summary.");
  await progress.finalize({ content: "Here is the summary.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const rows = taskUpdates(calls);
  // Final state per row id (task_update rows update in place by id).
  const finalById = new Map();
  for (const r of rows) finalById.set(r.id, r);
  const byTitle = (re) => [...finalById.values()].find((r) => re.test(r.title));

  const read = byTitle(/Read\(run\.js\)/);
  const bash = byTitle(/Bash/);
  assert.ok(read && bash, "both tool rows should be present");
  assert.equal(read.status, "complete", "an earlier tool completes when the next tool starts");
  assert.equal(bash.status, "complete", "the last tool completes when the answer text begins");

  const planA = byTitle(/Read the channel history/);
  const planB = byTitle(/Write the summary/);
  assert.ok(planA && planB, "both plan rows should be present");
  assert.equal(planA.status, "complete", "a completed todo maps to complete");
  assert.equal(planB.status, "in_progress", "an in-progress todo maps to in_progress");
  // The plan re-uses the same row id across snapshots rather than duplicating rows.
  assert.equal([...finalById.keys()].filter((id) => id.startsWith("plan-")).length, 2, "plan rows are stable by item text");
});

test("task timeline keeps native subagents concurrent and updates each stable row independently", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(calls),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  await cardReady();

  progress.onEvent({
    kind: "agent_activity",
    id: "agent-a",
    engine: "claude",
    name: "researcher",
    description: "Check Claude events",
    status: "running",
    aliasIds: ["thread-agent-a"],
  });
  progress.onEvent({
    kind: "agent_activity",
    id: "agent-b",
    engine: "codex",
    name: "reviewer",
    description: "Check Slack rows",
    status: "running",
  });
  progress.onEvent({
    kind: "agent_activity",
    id: "thread-agent-a",
    engine: "claude",
    status: "completed",
    elapsedMs: 9_200,
    tokens: 39_900,
    toolUses: 4,
    lastTool: "Read",
  });

  // The first agent finishing must not finish its sibling.
  await new Promise((resolve) => setImmediate(resolve));
  let finalById = new Map(taskUpdates(calls).map((row) => [row.id, row]));
  assert.equal([...finalById.values()].find((row) => /researcher/.test(row.title)).status, "complete");
  assert.equal([...finalById.values()].find((row) => /reviewer/.test(row.title)).status, "in_progress");

  progress.onEvent({
    kind: "agent_activity",
    id: "agent-b",
    engine: "codex",
    status: "failed",
    description: "Check Slack rows",
    elapsedMs: 6_000,
  });
  progress.onDelta("Review complete.");
  await progress.finalize({
    content: "Review complete.",
    durationMs: 10,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  finalById = new Map(taskUpdates(calls).map((row) => [row.id, row]));
  const researcher = [...finalById.values()].find((row) => /researcher/.test(row.title));
  const reviewer = [...finalById.values()].find((row) => /reviewer/.test(row.title));
  assert.match(researcher.title, /9s/);
  assert.match(researcher.title, /39\.9k tokens/);
  assert.match(researcher.title, /4 tools/);
  assert.match(researcher.title, /Read/);
  assert.equal(researcher.status, "complete");
  assert.match(reviewer.title, /^⚠️ 🤖/);
  assert.match(reviewer.title, /6s/);
  assert.equal(reviewer.status, "complete");
  assert.equal([...finalById.keys()].filter((id) => id.startsWith("agent-")).length, 2);
});

test("real Codex multi-agent JSONL becomes one card row per child", async () => {
  // Lines from the ROLLOUT of a Codex turn (CLI 0.152.0, multi_agent_version v2) whose two children
  // left no trace on the card: the spawn is a collaboration function call, the lifecycle rides
  // SubAgentActivity items, and the only collab tool call is an EMPTY `wait`. NOTE what this test
  // does and does not prove: `codex exec --json` forwards NONE of the identity-bearing lines below
  // (verified against CLI 0.153.4 — see the SLK-203 test further down), so this covers the mapping
  // for a stream that does carry them, and the live card is covered by the runner-level test in
  // test/codex-message-to-reply-e2e.js instead.
  const lines = [
    { type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{\"task_name\":\"sandbox_reviewer\",\"fork_turns\":\"all\",\"message\":\"gAAAAABqnJuNTot2…\"}", call_id: "call_A" } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "call_A", kind: "started", agent_thread_id: "thread-A", agent_path: "/root/sandbox_reviewer" } } },
    { type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{\"task_name\":\"connector_reviewer\",\"fork_turns\":\"all\",\"message\":\"gAAAAABqnJuQ7H6Hl3…\"}", call_id: "call_B" } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "call_B", kind: "started", agent_thread_id: "thread-B", agent_path: "/root/connector_reviewer" } } },
    // The wait, as `codex exec --json` reports it: an empty collab item, started then completed.
    { type: "item.started", item: { type: "collab_tool_call", id: "item_5", tool: "wait", status: "in_progress", receiver_thread_ids: [], receiver_agents: [], agents_states: {} } },
    { type: "item.completed", item: { type: "collab_tool_call", id: "item_5", tool: "wait", status: "completed", receiver_thread_ids: [], receiver_agents: [], agents_states: {} } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "subagent-completed-1", kind: "completed", agent_thread_id: "thread-A", agent_path: "/root/sandbox_reviewer" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "subagent-completed-2", kind: "completed", agent_thread_id: "thread-B", agent_path: "/root/connector_reviewer" } } },
  ];

  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();
  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-sol" });

  for (const line of lines) {
    const mapped = progressFromCodexEvent(line);
    assert.ok(mapped, `every subagent line must map to progress: ${JSON.stringify(line).slice(0, 80)}`);
    if (mapped.event) progress.onEvent(mapped.event);
    for (const event of mapped.events || []) progress.onEvent(event);
  }
  progress.onDelta("Both reviews are in.");
  await progress.finalize({ content: "Both reviews are in.", durationMs: 10, usage: { input_tokens: 1, output_tokens: 1 } });

  const rows = terminalTaskUpdates(calls);
  const sandbox = rows.find((row) => /sandbox_reviewer/.test(row.title));
  const connector = rows.find((row) => /connector_reviewer/.test(row.title));
  assert.ok(sandbox && connector, "each child must own a row on the card");
  assert.equal(sandbox.status, "complete");
  assert.equal(connector.status, "complete");
  // The spawn call and the lifecycle items describe the SAME child: one row each, not two.
  assert.equal(rows.filter((row) => row.id.startsWith("agent-")).length, 2);
  // The children's names must never be an encrypted spawn payload.
  assert.ok(!rows.some((row) => /gAAAA/.test(row.title)), "an encrypted spawn message must never reach a row title");
  assert.ok(rows.some((row) => row.title === "wait_agent"), "the coordination step is visible too");
});

test("SLK-203: a Codex turn's subagent rows survive the anonymous wait item", async () => {
  // What the runner really emits for a Codex turn with two children, in order: the coordination
  // tool row (all `codex exec --json` reports), then a named row per child announced live from the
  // children's own rollouts, then the terminal row carrying the metrics the rollouts hold. Before
  // the fix the card had the first of those three and nothing else.
  const calls = [];
  const streamer = {
    ts: "1720000000.000101",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.223", { authorId: "U1", teamId: "T1" });
  await cardReady();
  progress.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-codex" });

  progress.onEvent({ kind: "tool_use", id: "item_1", name: "wait_agent" });
  progress.onEvent({ kind: "agent_activity", id: "child-sandbox", engine: "codex", name: "sandbox_reviewer", status: "running" });
  progress.onEvent({ kind: "agent_activity", id: "child-connector", engine: "codex", name: "connector_reviewer", status: "running" });
  progress.onEvent({ kind: "tool_result", id: "item_1", name: "wait_agent", status: "completed" });
  progress.onEvent({ kind: "agent_activity", id: "child-sandbox", engine: "codex", name: "sandbox_reviewer", status: "completed", elapsedMs: 24_000, tokens: 4_010 });
  progress.onEvent({ kind: "agent_activity", id: "child-connector", engine: "codex", name: "connector_reviewer", status: "completed", elapsedMs: 20_000, tokens: 6_010 });
  progress.onDelta("Both reviews are in.");
  await progress.finalize({ content: "Both reviews are in.", durationMs: 10, usage: { input_tokens: 1, output_tokens: 1 } });

  const rows = terminalTaskUpdates(calls);
  const sandbox = rows.find((row) => /sandbox_reviewer/.test(row.title));
  const connector = rows.find((row) => /connector_reviewer/.test(row.title));
  assert.ok(sandbox && connector, "each child owns a card row of its own");
  assert.equal(rows.filter((row) => row.id.startsWith("agent-")).length, 2);
  assert.equal(sandbox.status, "complete");
  assert.equal(connector.status, "complete");
  // The rollout metrics reach the row: how long the child ran and what it spent.
  assert.match(sandbox.title, /24s/);
  assert.match(sandbox.title, /4k tokens/);
  assert.match(connector.title, /20s/);
  // A live announcement followed by the terminal one is ONE row, never two.
  assert.equal(new Set(rows.filter((row) => row.id.startsWith("agent-")).map((row) => row.id)).size, 2);
  // And the coordination step the model actually called stays on the card next to them.
  assert.ok(rows.some((row) => row.title === "wait_agent"));
});

test("in an assistant thread the shimmer makes parallel agent work visible", async () => {
  const calls = [];
  const client = {
    apiCall: async (method, payload) => calls.push([method, payload]),
    chatStream: () => ({ append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {} },
  };
  const progress = startProgress("stream", client, "C_ASSIST_AGENTS", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onEvent({ kind: "agent_activity", id: "agent-a", name: "researcher", status: "running" });
  progress.onEvent({ kind: "agent_activity", id: "agent-b", name: "reviewer", status: "running" });
  await cardReady();
  await progress.stop();
  assert.ok(
    calls.some((call) => call[0] === "assistant.threads.setStatus" && /coordinating 2 agents/.test(call[1].status)),
    "the native shimmer should make parallel agent work visible",
  );
});

test("task timeline terminalizes a subagent with no completion event", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  await cardReady();

  progress.onEvent({
    kind: "agent_activity",
    id: "agent-missing",
    name: "general-purpose",
    description: "Wait for a terminal event",
    status: "running",
  });
  await progress.finalize({
    content: "Done.",
    durationMs: 10,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const finalById = new Map(taskUpdates(calls).map((row) => [row.id, row]));
  const row = [...finalById.values()].find((candidate) => /general-purpose/.test(candidate.title));
  assert.equal(row.status, "complete");
  assert.match(row.title, /^⚠️ 🤖/);
  assert.match(row.title, /status unavailable/);
});

test("stopping a turn closes every running subagent row as stopped", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  await cardReady();

  progress.onEvent({
    kind: "agent_activity",
    id: "agent-stopped",
    name: "reviewer",
    description: "Review the changes",
    status: "running",
  });
  await progress.stop();

  const finalById = new Map(terminalTaskUpdates(calls).map((row) => [row.id, row]));
  const row = [...finalById.values()].find((candidate) => /reviewer/.test(candidate.title));
  assert.equal(row.status, "complete");
  assert.match(row.title, /^⚠️ 🤖/);
  assert.match(row.title, /stopped/);
});

test("task timeline failure logs a sanitized code without dropping the streamed answer", async (t) => {
  const calls = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => {
      // Fail the first task_update append (a workspace that can't render task chunks).
      if ((payload?.chunks || []).some((c) => c.type === "task_update")) {
        const error = new Error("secret payload must never reach logs");
        error.data = { error: "invalid_arguments" };
        throw error;
      }
      calls.push(["append", payload]);
    },
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (p) => calls.push(["postMessage", p]) },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "x" }); // task_update append rejects
  progress.onDelta("The answer.");
  await progress.finalize({ content: "The answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  // Card failed, but the answer still streamed and finalized natively (no plain-post fallback).
  assert.ok(calls.some((c) => c[0] === "append" && /answer/i.test(c[1]?.markdown_text || "")), "answer text still streams after a card failure");
  assert.ok(calls.some((c) => c[0] === "stopStream"), "stream still finalizes natively");
  assert.equal(terminalTaskUpdates(calls).length, 0, "a disabled card is not retried during stopStream");
  assert.equal(calls.some((c) => c[0] === "postMessage"), false, "a card failure must not force the plain-post fallback");
  assert.equal(warnings.length, 1, "the failure site should warn once");
  assert.match(warnings[0], /\(invalid_arguments\)/);
  assert.doesNotMatch(warnings[0], /secret|payload/i, "diagnostics must never include error messages or request payloads");
});

test("progress report joins rich semantic stages and tool history in one durable toolbox", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: {
      postMessage: async (payload) => {
        calls.push(["postMessage", payload]);
        return { ts: "1720000000.000200" };
      },
      update: async (payload) => calls.push(["update", payload]),
    },
  };
  const progress = startProgress("stream", client, "C_PLAN", "1720000000.000000", {
    authorId: "U1",
    teamId: "T1",
  });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Prepare customer launch",
    steps: [
      {
        id: "collect-context",
        title: "Collect context",
        status: "in_progress",
        details: "Read the customer record.",
        output: "Three meetings found.",
        sources: [{ url: "https://example.com/customer", text: "CRM record" }],
      },
      { id: "draft", title: "Draft launch brief", status: "pending", details: "", output: "", sources: [] },
    ],
  });
  progress.onEvent({
    kind: "report_progress",
    title: "Prepare customer launch",
    steps: [
      {
        id: "collect-context",
        title: "Collect context",
        status: "complete",
        details: "Read the customer record.",
        output: "Three meetings found.",
        sources: [{ url: "https://example.com/customer", text: "CRM record" }],
      },
      { id: "draft", title: "Draft launch brief", status: "in_progress", details: "", output: "", sources: [] },
    ],
  });
  // An identical authoritative snapshot should not spend another chat.update call.
  progress.onEvent({
    kind: "report_progress",
    title: "Prepare customer launch",
    steps: [
      {
        id: "collect-context",
        title: "Collect context",
        status: "complete",
        details: "Read the customer record.",
        output: "Three meetings found.",
        sources: [{ url: "https://example.com/customer", text: "CRM record" }],
      },
      { id: "draft", title: "Draft launch brief", status: "in_progress", details: "", output: "", sources: [] },
    ],
  });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("Launch brief ready.");
  await progress.finalize({ content: "Launch brief ready.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(calls.filter((call) => call[0] === "postMessage").length, 0,
    "semantic progress must not create a third persistent Slack message");
  assert.equal(calls.filter((call) => call[0] === "update").length, 0,
    "all progress-report revisions belong to the answer stream");

  const liveReportRows = calls
    .filter((call) => call[0] === "append")
    .flatMap((call) => taskUpdates([call]))
    .filter((task) => task.id.startsWith("report-"));
  assert.equal(liveReportRows.length, 4,
    "two changed snapshots should emit two rows each; the identical snapshot must deduplicate");
  assert.deepEqual(planUpdates(calls).map((chunk) => chunk.title), [
    "Prepare customer launch",
    "Prepare customer launch",
  ], "the plan title streams once live and is sealed once in the terminal snapshot");

  // Slack appends rich output, so the stage's details/output ride the chunk that first publishes
  // them and are never repeated — not on the status flip, not in the terminal seal.
  const collectRows = liveReportRows.filter((task) => task.id === "report-collect-context");
  assert.equal(collectRows[0].output, "Three meetings found.", "the stage publishes its output once");
  assert.equal("output" in collectRows[1], false, "an unchanged output is not re-sent when the status flips");
  assert.equal("details" in collectRows[1], false, "an unchanged detail is not re-sent either");
  assert.equal(renderedRows(calls).get("report-collect-context").output, "Three meetings found.",
    "the finished card must render the stage output exactly once");

  const terminal = new Map(terminalTaskUpdates(calls).map((task) => [task.id, task]));
  assert.deepEqual(terminal.get("report-collect-context"), {
    type: "task_update",
    id: "report-collect-context",
    title: "Collect context",
    status: "complete",
    sources: [{ type: "url", url: "https://example.com/customer", text: "CRM record" }],
  }, "the seal replaces the row's title/status without appending its output a third time");
  assert.deepEqual(terminal.get("report-draft"), {
    type: "task_update",
    id: "report-draft",
    title: "Draft launch brief",
    status: "in_progress",
  });
  assert.ok([...terminal.values()].some((task) => /Bash/.test(task.title)),
    "ordinary tool history must share the same terminal toolbox");
});

test("progress-report toolbox writes restore the independent temporary assistant status", async () => {
  let visibleStatus = "";
  const streamWrites = [];
  const client = {
    apiCall: async (_method, payload) => { visibleStatus = payload.status; },
    chatStream: () => ({
      ts: "1720000000.000100",
      append: async (payload) => {
        streamWrites.push(payload);
        visibleStatus = "";
      },
      stop: async () => {},
    }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_PLAN_STATUS", "111.222", {
    authorId: "U1",
    teamId: "T1",
  });
  progress.onRuntimeResolved({ engine: "claude", model: "claude-opus-4-8" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Ship status lifecycle",
    steps: [{ id: "fix", title: "Fix lifecycle", status: "in_progress", details: "", output: "", sources: [] }],
  });
  await cardReady();
  assert.ok(streamWrites[0]?.chunks.some((chunk) => chunk.type === "plan_update"),
    "the first progress-report snapshot should title the durable toolbox");
  assert.match(visibleStatus, /gathering information/, "the live status should return after the toolbox append clears it");

  progress.onEvent({
    kind: "report_progress",
    title: "Ship status lifecycle",
    steps: [{ id: "fix", title: "Fix lifecycle", status: "complete", details: "", output: "Done.", sources: [] }],
  });
  await cardReady();
  assert.ok(streamWrites[1]?.chunks.some((chunk) => chunk.id === "report-fix" && chunk.status === "complete"),
    "the next progress-report snapshot should update the durable toolbox row");
  assert.match(visibleStatus, /gathering information/, "the live status should also return after a toolbox update");

  await progress.stop();
  assert.equal(visibleStatus, "", "toolbox status restoration cannot survive terminal cleanup");
});

test("a rejected progress-report chunk disables only the shared toolbox, not answer streaming", async (t) => {
  const calls = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => {
      if (payload?.chunks?.some((chunk) => chunk.type === "plan_update")) {
        throw Object.assign(new Error("secret progress-report payload"), { code: "invalid_chunks" });
      }
      calls.push(["append", payload]);
    },
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Run checks",
    steps: [{ id: "tests", title: "Run tests", status: "in_progress", details: "", output: "", sources: [] }],
  });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("Checks passed.");
  await progress.finalize({ content: "Checks passed.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.ok(calls.some((call) => call[0] === "append" && /Checks passed/.test(call[1]?.markdown_text || "")),
    "the answer still appends after a toolbox failure");
  assert.equal(taskUpdates(calls).length, 0, "the failed shared toolbox should not be retried at finalization");
  assert.ok(calls.some((call) => call[0] === "stopStream"), "the answer stream still finalizes natively");
  assert.equal(calls.filter((call) => call[0] === "postMessage").length, 0,
    "a toolbox failure must not trigger classic answer fallback");
  assert.equal(warnings.length, 1, "the first toolbox failure should emit one diagnostic");
  assert.match(warnings[0], /task-card append failed \(invalid_chunks\)/i);
  assert.ok(warnings[0].length < 200, "the diagnostic should be bounded and omit payloads");
});

test("progress-report title revisions stay in the same toolbox with stable task ids", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Run checks",
    steps: [{ id: "tests", title: "Run tests", status: "in_progress", details: "", output: "", sources: [] }],
  });
  progress.onEvent({
    kind: "report_progress",
    title: "Verify checks",
    steps: [{ id: "tests", title: "Run tests", status: "complete", details: "", output: "Passed.", sources: [] }],
  });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("Checks passed.");
  await progress.finalize({ content: "Checks passed.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(calls.filter((call) => call[0] === "postMessage").length, 0);
  assert.equal(calls.filter((call) => call[0] === "update").length, 0);
  assert.deepEqual(planUpdates(calls).map((chunk) => chunk.title), ["Run checks", "Verify checks", "Verify checks"]);
  const reportRows = terminalTaskUpdates(calls).filter((task) => task.id === "report-tests");
  assert.equal(reportRows.length, 1, "the terminal toolbox should contain one stable row per progress-report step");
  assert.equal(reportRows[0].status, "complete");
  assert.equal("output" in reportRows[0], false, "the seal must not append the output the live chunk already carried");
  assert.equal(renderedRows(calls).get("report-tests").output, "Passed.",
    "the finished card renders the stage output exactly once");
  assert.ok(terminalTaskUpdates(calls).some((task) => /Bash/.test(task.title)));
  assert.ok(calls.some((call) => call[0] === "append" && /Checks passed/.test(call[1]?.markdown_text || "")));
  assert.ok(calls.some((call) => call[0] === "stopStream"));
});

test("progress-report revisions remove stale rich fields from the terminal toolbox row", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Run checks",
    steps: [{
      id: "tests",
      title: "Run tests",
      status: "in_progress",
      details: "Full repository suite.",
      output: "Running.",
      sources: [{ url: "https://example.com/build", text: "Build" }],
    }],
  });
  progress.onEvent({
    kind: "report_progress",
    title: "Run checks",
    steps: [{ id: "tests", title: "Run tests", status: "complete", details: "", output: "Passed.", sources: [] }],
  });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("Checks passed.");
  await progress.finalize({ content: "Checks passed.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(calls.filter((call) => call[0] === "postMessage").length, 0,
    "progress-report revisions should remain in the answer stream");
  assert.equal(calls.filter((call) => call[0] === "update").length, 0);
  const row = terminalTaskUpdates(calls).find((task) => task.id === "report-tests");
  assert.deepEqual(row, {
    type: "task_update",
    id: "report-tests",
    title: "Run tests",
    status: "complete",
  }, "the authoritative snapshot drops details/sources it no longer contains and never repeats a delivered output");
  assert.equal(renderedRows(calls).get("report-tests").output, "Running.Passed.",
    "each authoritative output is appended once — the revision, never the seal, changes what the row shows");
  assert.ok(terminalTaskUpdates(calls).some((task) => /Bash/.test(task.title)));
  assert.ok(calls.some((call) => call[0] === "append" && /Checks passed/.test(call[1]?.markdown_text || "")));
  assert.ok(calls.some((call) => call[0] === "stopStream"));
});

test("stopping a run drains progress-report chunks then seals only its active step as interrupted", async () => {
  const calls = [];
  let releaseAppend;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  let gated = false;
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => {
      calls.push(["append", payload]);
      if (!gated && payload?.chunks?.some((chunk) => chunk.type === "plan_update")) {
        gated = true;
        await appendGate;
      }
    },
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [
      { id: "done", title: "Build", status: "complete", details: "", output: "Built.", sources: [] },
      { id: "active", title: "Deploy", status: "in_progress", details: "Production deploy.", output: "", sources: [] },
      { id: "later", title: "Verify", status: "pending", details: "", output: "", sources: [] },
    ],
  });
  const stopping = progress.stop();
  let stopResolved = false;
  stopping.then(() => { stopResolved = true; });
  await Promise.resolve();
  assert.equal(stopResolved, false, "stop must wait for queued progress-report chunks");
  releaseAppend();
  await stopping;

  assert.equal(calls.filter((call) => call[0] === "postMessage").length, 0);
  assert.equal(calls.filter((call) => call[0] === "update").length, 0);
  assert.equal(calls.at(-1)[0], "stopStream", "the terminal toolbox snapshot closes the one stream");
  const tasks = terminalTaskUpdates(calls).filter((task) => task.id.startsWith("report-"));
  // Terminal, not `error`: Slack paints the whole card's header from the aggregate row statuses,
  // so flagging a user-requested stop as an error would render "Something went wrong" over a turn
  // that did exactly what was asked. The interruption is carried by the row's own title/output.
  assert.deepEqual(tasks.map((task) => task.status), ["complete", "complete", "pending"]);
  assert.match(tasks[1].title, /^⚠️ /, "the interrupted step stays visually distinct from a clean finish");
  const sealed = renderedRows(calls);
  assert.match(sealed.get("report-active").output, /interrupt/i);
  assert.equal(sealed.get("report-done").output, "Built.",
    "a completed output is preserved and rendered exactly once, not repeated by the seal");
  assert.equal("output" in tasks[0], false, "the seal must not append an output the live chunk already carried");

  const appendsBeforeLateEvent = calls.filter((call) => call[0] === "append").length;
  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [
      { id: "done", title: "Build", status: "complete", details: "", output: "Built.", sources: [] },
      { id: "active", title: "Deploy", status: "complete", details: "Production deploy.", output: "Deployed.", sources: [] },
      { id: "later", title: "Verify", status: "in_progress", details: "", output: "", sources: [] },
    ],
  });
  await progress.stop();
  assert.equal(calls.filter((call) => call[0] === "append").length, appendsBeforeLateEvent,
    "a late snapshot cannot overwrite the forced interruption state");
  assert.equal(calls.filter((call) => call[0] === "stopStream").length, 1, "stop is terminal and idempotent");
});

test("finalize closes in-stream progress-report intake without changing declared statuses", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: {
      postMessage: async (payload) => {
        calls.push(["postMessage", payload]);
        return { ts: "1720000000.000200" };
      },
      update: async (payload) => calls.push(["update", payload]),
    },
  };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });

  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [{ id: "ship", title: "Ship", status: "pending", details: "", output: "", sources: [] }],
  });
  progress.onDelta("Done.");
  await progress.finalize({ content: "Done.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });
  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [{ id: "ship", title: "Ship", status: "complete", details: "", output: "Done.", sources: [] }],
  });
  await progress.stop();

  assert.equal(calls.filter((call) => call[0] === "postMessage" || call[0] === "update").length, 0,
    "progress-report state must stay inside the answer stream");
  assert.equal(calls.filter((call) => call[0] === "stopStream").length, 2,
    "the separate progress and answer streams both close exactly once");
  assert.equal(terminalTaskUpdates(calls).find((task) => task.id === "report-ship")?.status, "pending",
    "finalize must not invent a terminal task status");
});

test("failed native and classic final delivery interrupts an active in-stream progress report exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  let nativeStopAttempts = 0;
  let postAttempts = 0;
  let streamSeq = 0;
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => {
      const id = ++streamSeq;
      return {
        ts: `1720000000.00010${id}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => {
          calls.push(["stopStream", payload, id]);
          if (id === 2) {
            nativeStopAttempts += 1;
            throw new Error("native finalization failed");
          }
        },
      };
    },
    chat: {
      postMessage: async (payload) => {
        postAttempts += 1;
        calls.push(["postMessage", payload]);
        throw new Error("classic fallback failed");
      },
      update: async (payload) => calls.push(["update", payload]),
    },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [{ id: "ship", title: "Ship", status: "in_progress", details: "", output: "", sources: [] }],
  });
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  progress.onDelta("Delivery attempted.");
  await assert.rejects(
    progress.finalize({ content: "Delivery attempted.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } }),
    /classic fallback failed/,
  );
  await progress.stop(); // mirrors the outer run error path
  await progress.stop(); // terminal retries remain idempotent

  const reportRows = taskUpdates(calls).filter((task) => task.id === "report-ship");
  const interruptedRows = reportRows.filter((task) => /interrupt/i.test(task.output || ""));
  const interruptedAppends = calls.filter((call) =>
    call[0] === "append" && taskUpdates([call]).some((task) => task.id === "report-ship" && /interrupt/i.test(task.output || "")));
  assert.equal(interruptedAppends.length, 1,
    "the failed final delivery should emit exactly one interrupted progress-report transition");
  assert.ok(interruptedRows.every((row) => row.status === "complete"),
    "the live transition and terminal snapshot both close the row without a card-wide error");
  assert.match(renderedRows(calls).get("report-ship").output, /interrupt/i,
    "the card renders the interruption once, from the live transition rather than the seal");
  assert.equal(nativeStopAttempts, 1, "the outer stop path must not retry native finalization");
  assert.equal(postAttempts, 1, "only one classic fallback attempt should run");
  assert.ok(heartbeatUpdates(calls).length > 0, "precondition — delivery failed after liveness became visible");
  assert.ok(heartbeatUpdates(calls).every((row) => row.status === "complete"),
    "failed final delivery must not strand an in-progress heartbeat");
  const interruptedAppend = calls.findIndex((call) =>
    call[0] === "append" && taskUpdates([call]).some((task) => task.id === "report-ship" && /interrupt/i.test(task.output || "")));
  assert.ok(interruptedAppend > calls.findIndex((call) => call[0] === "stopStream"),
    "the queued interruption chunk drains after final delivery fails");
});

// The liveness heartbeat. Every other row is event-driven, so a turn that goes quiet — long
// reasoning, a working subagent, API backoff under a usage limit — used to leave a frozen card
// indistinguishable from a dead run. Completed heartbeat pulses tick on a timer instead, carrying
// elapsed time and the last thing we saw, and they must NOT appear for a prompt answer.
test("a silent run grows a ticking heartbeat row that names the last activity", async (t) => {
  // Date too: the row dedupes identical titles, so elapsed time has to genuinely advance for a
  // second beat to be emitted at all — which is exactly the property under test.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });

  // Go quiet: no further engine events, only time passing.
  t.mock.timers.tick(20_000);
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));

  const beats = heartbeatUpdates(calls);
  assert.ok(beats.length >= 2, "the row must tick more than once while nothing else happens");
  assert.ok(beats.every((b) => b.status === "complete"), "liveness pulses never leave a task open");
  assert.match(beats[0].title, /Working/);
  assert.ok(beats.at(-1).title.includes("Bash"), "it should name the last activity we saw");
  assert.notEqual(beats[0].title, beats.at(-1).title, "elapsed time must actually advance");
});

test("a run past five minutes rotates completed heartbeat rows and stays visibly live", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
  });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "long audit" });

  // Advance in heartbeat-sized steps so this verifies both sides of the four-minute rotation and
  // several visible pulses beyond Slack's observed ~five-minute failure boundary.
  for (let i = 0; i < 16; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));

  const beats = heartbeatUpdates(calls);
  assert.deepEqual([...new Set(beats.map((row) => row.id))], ["heartbeat-0", "heartbeat-1"],
    "the heartbeat identity rotates once before it can reach five minutes");
  assert.ok(beats.every((row) => row.status === "complete"),
    "no live heartbeat update is left in progress, including after rotation");
  assert.match(beats.at(-1).title, /5m20s/, "liveness remains visibly fresh beyond five minutes");

  await progress.finalize({ content: "Audit complete." });
  assert.ok(heartbeatUpdates(calls).every((row) => row.status === "complete"));
});

test("a long pre-answer card rolls to a fresh Slack stream before five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streams = [];
  const client = {
    apiCall: refuseStatus(),
    chatStream: (args) => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00010${streams.length + 1}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      calls.push(["chatStream", args, id]);
      return stream;
    },
    chat: {
      postMessage: async () => {},
      update: async () => {},
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
  });
  await cardReady();
  progress.onEvent({
    kind: "report_progress",
    title: "Long audit run",
    steps: [{ id: "audit", title: "Audit gateway", status: "in_progress", details: "Trace lifecycle.", output: "", sources: [] }],
  });
  progress.onEvent({ kind: "tool_use", id: "read-1", name: "Read", target: "audit.js" });
  progress.onEvent({ kind: "tool_result", id: "read-1", name: "Read", target: "audit.js", status: "completed" });
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "long audit" });
  await new Promise((resolve) => setImmediate(resolve));

  // The 20-second liveness tick first observes the 4.5-minute rollover threshold at 4m40s.
  for (let i = 0; i < 14; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streams.length, 2, "the old message must not remain in streaming state for five minutes");
  const retired = calls.find((call) => call[0] === "stopStream" && call[2] === "stream-1");
  assert.equal(retired?.[1]?.markdown_text, undefined,
    "the retired progress message contains task chunks only, never answer text");
  assert.equal(retired?.[1]?.chunks?.find((chunk) => chunk.type === "plan_update")?.title, "Long audit run",
    "the retired message must retain its semantic progress-report title");
  assert.equal(retired?.[1]?.chunks?.find((chunk) => chunk.id === "report-audit")?.status, "complete",
    "the retired progress-report step must not leave an abandoned spinner");
  const retiredTool = retired?.[1]?.chunks?.find((chunk) =>
    chunk.type === "task_update" && /long audit/.test(chunk.title));
  assert.equal(retiredTool?.status, "complete",
    "the retired message must keep a terminal toolbox instead of an abandoned spinner");
  const successorTool = calls
    .filter((call) => call[0] === "append" && call[2] === "stream-2")
    .flatMap((call) => call[1]?.chunks || [])
    .find((chunk) => chunk.type === "task_update" && /long audit/.test(chunk.title));
  assert.equal(successorTool?.status, "in_progress",
    "the successor card should resume the task that is still running");
  const successorChunks = calls
    .filter((call) => call[0] === "append" && call[2] === "stream-2")
    .flatMap((call) => call[1]?.chunks || []);
  assert.equal(successorChunks.find((chunk) => chunk.type === "plan_update")?.title, "Long audit run");
  assert.equal(successorChunks.find((chunk) => /Read\(audit\.js\)/.test(chunk.title))?.status, "complete",
    "the replacement toolbox must inherit completed history, not only still-active rows");
  assert.equal(successorChunks.find((chunk) => chunk.id === "report-audit")?.status, "in_progress",
    "the successor toolbox should resume the live semantic progress-report step");
  const firstDelete = calls.findIndex((call) => call[0] === "delete" && call[1].ts === streams[0].ts);
  const successorDurable = calls.findIndex((call) => call[0] === "append" && call[2] === "stream-2");
  assert.ok(firstDelete > successorDurable,
    "the retired message may be removed only after its full replacement is durable");

  // The safeguard is periodic, not a one-shot escape hatch: an hour-long run keeps every
  // individual Slack message below the same boundary.
  for (let i = 0; i < 14; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streams.length, 3, "the successor must roll again if the run remains active");
  const secondRetired = calls.find((call) => call[0] === "stopStream" && call[2] === "stream-2");
  assert.equal(secondRetired?.[1]?.chunks?.find((chunk) => /long audit/.test(chunk.title))?.status, "complete",
    "every rollover must leave its own durable terminal toolbox");
  assert.deepEqual(
    calls.filter((call) => call[0] === "delete").map((call) => call[1].ts),
    [streams[0].ts, streams[1].ts],
    "each superseded copy should disappear so one compiled reply remains visible",
  );

  progress.onDelta("Audit complete.");
  await progress.finalize({ content: "Audit complete." });
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-1").length, 1);
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-3").length, 1,
    "finalization closes the current progress-card successor");
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-4").length, 1,
    "final delivery closes the separate answer stream");
});

test("a long streamed answer also rolls before its message reaches five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streams = [];
  const client = {
    apiCall: async () => {}, // assistant thread: persistent toolbox plus temporary status
    chatStream: (args) => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00020${streams.length + 1}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      calls.push(["chatStream", args, id]);
      return stream;
    },
    chat: {
      postMessage: async () => {},
      update: async () => {},
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };

  const progress = startProgress("stream", client, "C_ASSIST_LONG_ANSWER", "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
  });
  const answerStart = `\`\`\`js\n${"A".repeat(300)}`;
  progress.onDelta(answerStart);
  await new Promise((resolve) => setImmediate(resolve));

  for (let i = 0; i < 14; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streams.length, 2,
    "answer text must not pin one native stream past Slack's client-side age limit");
  const retiredText = calls.find((call) => call[0] === "stopStream" && call[2] === "stream-1")?.[1]?.markdown_text || "";
  assert.match(retiredText, /refreshing|replaced below/i);
  assert.match(retiredText, /```\n\n_⏳/, "rollover must close an open code fence before its marker");
  const successorText = calls.find((call) => call[0] === "append" && call[2] === "stream-2")?.[1]?.markdown_text || "";
  assert.equal(successorText, answerStart,
    "the replacement must carry the full compiled answer without continuation scaffolding");
  assert.equal(calls.find((call) => call[0] === "delete")?.[1]?.ts, streams[0].ts,
    "the split predecessor should disappear once the compiled replacement exists");

  const answerEnd = "\n```\nFinal sentence.";
  progress.onDelta(answerEnd);
  await progress.finalize({ content: `${answerStart}${answerEnd}` });
  assert.ok(calls.some((call) => call[0] === "append" && call[2] === "stream-2" && /Final sentence/.test(call[1]?.markdown_text || "")));
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-2").length, 1);
});

test("a failed rollover cleanup keeps both durable copies without losing the authoritative answer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const streams = [];
  const client = {
    apiCall: async () => {},
    chatStream: () => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00040${streams.length + 1}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      return stream;
    },
    chat: {
      postMessage: async () => {},
      update: async () => {},
      delete: async () => { throw Object.assign(new Error("cannot delete secret payload"), { data: { error: "cant_delete_message" } }); },
    },
  };
  const progress = startProgress("stream", client, "C_DELETE_FAIL", "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
  });
  progress.onDelta("A".repeat(300));
  await cardReady();

  for (let i = 0; i < 14; i += 1) t.mock.timers.tick(20_000);
  await cardReady();

  assert.equal(streams.length, 2, "cleanup failure must not prevent a fresh safe-age stream");
  assert.equal(
    calls.find((call) => call[0] === "append" && call[2] === "stream-2")?.[1]?.markdown_text,
    "A".repeat(300),
    "the successor remains the complete authoritative copy",
  );
  assert.ok(warnings.some((warning) => /cleanup.*cant_delete_message/.test(warning)));
  assert.ok(warnings.every((warning) => !/secret payload/.test(warning)), "cleanup diagnostics must stay sanitized");

  await progress.finalize({ content: "A".repeat(300) });
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-2").length, 1,
    "the replacement must still finalize normally");
});

test("a successor that cannot be seeded falls back to one complete classic answer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const streams = [];
  const client = {
    apiCall: async () => {},
    chatStream: () => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: `1720000000.00050${streams.length + 1}`,
        append: async (payload) => {
          calls.push(["append", payload, id]);
          if (id === "stream-2") {
            throw Object.assign(new Error("do not log private answer"), { data: { error: "seed_failed" } });
          }
        },
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      return stream;
    },
    chat: {
      postMessage: async (payload) => {
        calls.push(["postMessage", payload]);
        return { ts: "1720000000.000599" };
      },
      update: async () => {},
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };
  const progress = startProgress("stream", client, "C_SEED_FAIL", "1720000000.000000");
  const fullAnswer = `${"A".repeat(300)} — safely complete`;
  progress.onDelta("A".repeat(300));
  await cardReady();

  for (let i = 0; i < 14; i += 1) t.mock.timers.tick(20_000);
  await cardReady();

  assert.equal(streams.length, 2, "the rollover should attempt a fresh safe-age stream");
  assert.equal(calls.filter((call) => call[0] === "delete").length, 0,
    "the predecessor must remain until its replacement is durable");
  assert.ok(warnings.some((warning) => /rollover.*seed_failed/.test(warning)));
  assert.ok(warnings.every((warning) => !/private answer/.test(warning)), "rollover diagnostics stay sanitized");

  await progress.finalize({ content: fullAnswer });
  const fallback = calls.find((call) => call[0] === "postMessage");
  assert.ok(fallback?.[1]?.text?.startsWith(fullAnswer),
    "finalization must deliver the complete authoritative answer through the classic fallback");
  assert.equal(calls.filter((call) => call[0] === "stopStream" && call[2] === "stream-2").length, 0,
    "a broken empty successor must not be treated as a successful native reply");
});

test("the rollover age starts when Slack creates the message, not when chatStream is constructed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streams = [];
  const client = {
    apiCall: async () => {},
    chatStream: () => {
      const id = `stream-${streams.length + 1}`;
      const stream = {
        id,
        ts: undefined,
        append: async (payload) => {
          stream.ts ??= `1720000000.00030${streams.length + 1}`;
          calls.push(["append", payload, id]);
        },
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      streams.push(stream);
      return stream;
    },
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_ASSIST_LATE_START", "1720000000.000000", {
    authorId: "U123",
    teamId: "T123",
  });

  // Before answer text exists, only the independently live progress stream may be created/rolled.
  for (let i = 0; i < 16; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call[0] === "append" && call[1]?.markdown_text), false,
    "progress activity must not create a fake answer message");

  progress.onDelta("B".repeat(300));
  await new Promise((resolve) => setImmediate(resolve));
  const answerStreamId = calls.find((call) => call[0] === "append" && call[1]?.markdown_text)?.[2];
  assert.ok(answerStreamId, "the first text delta creates the answer stream lazily");
  for (let i = 0; i < 13; i += 1) t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call[0] === "stopStream" && call[2] === answerStreamId), false,
    "the progress stream's earlier age must not count toward the answer message");

  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call[0] === "stopStream" && call[2] === answerStreamId),
    "the answer rolls once its own age reaches the threshold");
  await progress.finalize({ content: "B".repeat(300) });
});

test("an abrupt restart cannot strand a heartbeat task because every pulse is terminal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => ({
      ts: "1720000000.000100",
      append: async (payload) => calls.push(["append", payload]),
      stop: async (payload) => calls.push(["stopStream", payload]),
    }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123" });
  await cardReady();
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));

  // Intentionally do not call finalize()/stop(): this models the cleanup hook never running
  // because the daemon process vanished during a restart.
  const beats = heartbeatUpdates(calls);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].status, "complete");
  assert.equal(taskUpdates(calls).some((row) => row.id.startsWith("heartbeat-") && row.status === "in_progress"), false);
});

test("a run that answers promptly never shows a heartbeat row", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  await cardReady();
  progress.onDelta("Quick answer.");
  await progress.finalize({ content: "Quick answer." });

  assert.equal(heartbeatUpdates(calls).length, 0);
});

// A quiet engine is the case that used to look identical to a dead one. The watchdog now reports
// it instead of killing the turn, and the report has to reach the user — otherwise the run is
// still invisible and the whole change is pointless.
test("an engine going quiet is surfaced in the assistant status", async () => {
  const statuses = [];
  const client = {
    apiCall: async (method, payload) => {
      if (method === "assistant.threads.setStatus") statuses.push(payload.status);
    },
    chatStream: () => ({ ts: "1720000000.000100", append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, "C_ASSIST_QUIET", "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  progress.onEvent({ kind: "quiet", silentMs: 11 * 60_000, source: "warm" });
  await new Promise((r) => setImmediate(r));

  assert.ok(
    statuses.some((s) => /waiting/i.test(s) && s.includes("11m")),
    "the assistant status should say we are waiting and for how long",
  );
});

test("in a channel thread an engine going quiet immediately refreshes the heartbeat row", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  await cardReady();
  progress.onEvent({ kind: "quiet", silentMs: 11 * 60_000, source: "warm" });
  await new Promise((r) => setImmediate(r));

  const beats = heartbeatUpdates(calls);
  assert.equal(beats.length, 1, "a quiet report should immediately refresh the row, not wait for the next tick");
  assert.match(beats[0].title, /no output for 11m/);
  assert.match(beats[0].title, /still connected/);
});

// Silence with the harness still logging is a different situation from silence with nothing at
// all, and the difference is exactly what tells a user "it is retrying" rather than "it is
// thinking". The watchdog now knows which one it is; the row has to say so.
test("a quiet stretch says whether the harness is still logging", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  await cardReady();
  progress.onEvent({ kind: "quiet", silentMs: 11 * 60_000, livenessMs: 2_000, source: "codex" });
  await new Promise((r) => setImmediate(r));

  const beats = heartbeatUpdates(calls);
  assert.match(beats.at(-1).title, /no output for 11m/);
  assert.match(beats.at(-1).title, /still logging/);

  progress.onEvent({ kind: "quiet", silentMs: 12 * 60_000, livenessMs: null, source: "codex" });
  await new Promise((r) => setImmediate(r));
  assert.match(heartbeatUpdates(calls).at(-1).title, /still connected/, "no stderr at all is the ordinary quiet case");
});

// A turn can stall BEFORE its first token, where "quiet" has not fired yet and the row still says
// "starting". The harness usually knows why (retry, backoff, sign-in) and says so on stderr; that
// note is the difference between a run that looks dead and one that explains itself.
test("a harness diagnostic replaces 'starting' on the heartbeat row", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  await cardReady();
  progress.onEvent({ kind: "engine_note", source: "codex", text: "ERROR: not logged in. Run `codex login` to authenticate." });
  await new Promise((r) => setImmediate(r));

  const beats = heartbeatUpdates(calls);
  assert.equal(beats.length, 1, "a diagnostic should refresh the row immediately");
  assert.match(beats[0].title, /not logged in/);
  assert.doesNotMatch(beats[0].title, /starting/);
});

test("a harness diagnostic is surfaced in the assistant status too", async () => {
  const statuses = [];
  const client = {
    apiCall: async (method, payload) => {
      if (method === "assistant.threads.setStatus") statuses.push(payload.status);
    },
    chatStream: () => ({ ts: "1720000000.000100", append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, "C_ASSIST_NOTE", "1720000000.000000", { authorId: "U123", teamId: "T123", dir: null });
  progress.onEvent({ kind: "engine_note", source: "codex", text: "token refresh failed" });
  await new Promise((r) => setImmediate(r));

  assert.ok(statuses.some((s) => /token refresh failed/.test(s)), "the assistant status should name the problem");
});

// Subagents produce the longest silent stretches in a turn: the parent emits nothing at all while
// a child works, so "last event" alone would report something stale and misleading. The row has
// to say what is actually happening — that N children are still running.
test("the heartbeat reports running subagents, and stops once they finish", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onEvent({ kind: "agent_activity", id: "a1", name: "explorer", status: "running" });
  progress.onEvent({ kind: "agent_activity", id: "a2", name: "auditor", status: "running" });
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));

  let beats = heartbeatUpdates(calls);
  assert.match(beats.at(-1).title, /2 subagents running/);

  progress.onEvent({ kind: "agent_activity", id: "a1", name: "explorer", status: "completed" });
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));
  beats = heartbeatUpdates(calls);
  assert.match(beats.at(-1).title, /1 subagent running/);

  progress.onEvent({ kind: "agent_activity", id: "a2", name: "auditor", status: "completed" });
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));
  beats = heartbeatUpdates(calls);
  assert.ok(!/subagent[s]? running/.test(beats.at(-1).title), "finished agents must stop being counted");
});

// Slack renders a card with an open task as FAILED at stream end. Heartbeat pulses are already
// terminal, and a normal close additionally relabels the latest one for clarity.
test("a finished run leaves the latest heartbeat pulse complete", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  t.mock.timers.tick(20_000); // long enough to grow the row
  await new Promise((r) => setImmediate(r));
  assert.equal(heartbeatUpdates(calls).length, 1, "precondition — the row exists");

  progress.onDelta("All done.");
  await progress.finalize({ content: "All done." });

  const beats = heartbeatUpdates(calls);
  assert.equal(beats.at(-1).status, "complete", "the terminal relabel must not reopen the pulse");
});

test("a stopped run also closes the heartbeat row", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "x" });
  t.mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));

  await progress.stop();
  const beats = heartbeatUpdates(calls);
  assert.equal(beats.at(-1).status, "complete");
  assert.match(beats.at(-1).title, /Stopped/);
});

test("a run with steps does not append a toolbox recap line", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = { apiCall: refuseStatus(), chatStream: () => streamer, chat: { postMessage: async () => {}, update: async () => {} } };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onEvent({ kind: "tool_use", name: "Read", target: "a.js" });
  progress.onDelta("Answer text.");
  await progress.finalize({ content: "Answer text." });

  const texts = calls.filter((c) => c[0] === "append" && c[1]?.markdown_text).map((c) => c[1].markdown_text);
  assert.equal(texts.some((text) => /details in the card above/i.test(text)), false);
  assert.equal(texts.some((text) => /🧰/.test(text)), false);
});

test("a plain answer with no steps gets no toolbox recap line", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = { apiCall: refuseStatus(), chatStream: () => streamer, chat: { postMessage: async () => {}, update: async () => {} } };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  await cardReady();
  progress.onDelta("Just an answer.");
  await progress.finalize({ content: "Just an answer." });

  const texts = calls.filter((c) => c[0] === "append" && c[1]?.markdown_text).map((c) => c[1].markdown_text);
  assert.ok(!texts.some((text) => /details in the card above/i.test(text)), "a plain reply shouldn't carry run bookkeeping");
});

// CMD-207: a stopped run posted its full answer, unmarked, beneath the "🛑 Stopped." card. The
// answer message is created LAZILY by the first append that flushes, so deltas still queued behind
// Slack rate-limit back-pressure were created and posted by the stop path's own chain drain.
test("a stop before anything flushes creates no answer message at all", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: (payload) => {
      calls.push(["chatStream", payload]);
      return streamer;
    },
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  // Queue the whole answer WITHOUT draining: this is the back-pressure case — Slack has not
  // accepted a single append when the user stops the run.
  progress.onDelta("The answer the user stopped");
  progress.onDelta(" before any of it was posted.");
  await progress.stop();

  const answerText = calls
    .filter((call) => (call[0] === "append" || call[0] === "stopStream") && typeof call[1]?.markdown_text === "string")
    .map((call) => call[1].markdown_text)
    .join("");
  assert.equal(answerText, "", "a stopped run must not post the buffered answer under the stop card");
  assert.equal(calls.some((call) => call[0] === "chatStream"), false, "no answer message may be created by the stop path");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "and no classic fallback may deliver it either");
});

// The other half of CMD-207: the run's own finalize() racing the stop. Whatever already reached
// Slack stays (and is marked partial); the rest of the answer must not arrive afterwards.
test("a finalize after a stop is suppressed, and the partial text that landed says so", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: (payload) => {
      calls.push(["chatStream", payload]);
      return streamer;
    },
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };

  const progress = startProgress("stream", client, cardChannel(), "1720000000.000000", { authorId: "U1", teamId: "T1", dir: null });
  progress.onDelta("Half the answer");
  await cardReady();
  assert.ok(calls.some((call) => call[0] === "append" && /Half the answer/.test(call[1]?.markdown_text || "")),
    "precondition — the first half really reached Slack");

  await progress.stop();
  await progress.finalize({ content: "Half the answer and the rest of it.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const written = calls
    .filter((call) => (call[0] === "append" || call[0] === "stopStream") && typeof call[1]?.markdown_text === "string")
    .map((call) => call[1].markdown_text)
    .join("");
  assert.equal(/and the rest of it/.test(written), false, "the finalize must not deliver the answer the stop cut off");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "nor may the classic fallback deliver it");
  assert.match(written, /Stopped — partial answer/, "truncated text must never read as a finished answer");
  assert.equal(calls.filter((call) => call[0] === "stopStream").length, 1, "the answer stream closes exactly once");
});

// SLK-204. A model that writes one preamble sentence ("Let me check the tests first…") before its
// first tool call used to lose its whole toolbox: the answer-started guard latched the card OFF
// for the rest of the turn, so every later tool, failed tool and subagent row was dropped. Only
// the content-free liveness pulse is worth suppressing once the answer is under way.
test("a preamble sentence before the first tool call still opens the toolbox", async () => {
  const calls = [];
  let sequence = 0;
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => {
      const id = `stream-${++sequence}`;
      const stream = {
        id,
        ts: undefined,
        append: async (payload) => {
          stream.ts ??= `111.22${sequence}`;
          calls.push(["append", payload, id]);
        },
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
      return stream;
    },
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onDelta("Let me check the tests first. ");
  progress.onEvent({ kind: "tool_use", id: "t1", name: "Bash", target: "npm test" });
  progress.onEvent({ kind: "tool_result", id: "t1", name: "Bash", target: "npm test", status: "failed" });
  progress.onEvent({ kind: "agent_activity", id: "a1", name: "reviewer", description: "review the diff", status: "running" });
  progress.onEvent({ kind: "agent_activity", id: "a1", status: "completed" });
  progress.onDelta("They pass now.");
  await progress.finalize({ content: "Let me check the tests first. They pass now." });

  const rows = [...renderedRows(calls).values()];
  const bash = rows.find((row) => /Bash\(npm test\)/.test(row.title));
  assert.ok(bash, "a tool that runs after the first answer delta must still get its toolbox row");
  assert.equal(bash.status, "complete", "the row still closes terminally");
  assert.match(bash.title, /^⚠️ .* · failed$/, "a failed tool keeps its own failure label");
  assert.ok(rows.some((row) => /🤖 reviewer/.test(row.title)), "subagent rows are not dropped either");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "the toolbox stays inside the streams");
  // The card is its own message, so a card opened after the answer began simply lands beneath it —
  // that is strictly better than losing every row for the rest of the turn.
  const cardWrites = calls.filter((call) => call[0] === "append" && call[1]?.chunks);
  const answerWrites = calls.filter((call) => call[0] === "append" && call[1]?.markdown_text);
  assert.ok(cardWrites.length > 0, "the toolbox is streamed");
  assert.notEqual(cardWrites[0][2], answerWrites[0][2], "task chunks and answer text keep separate messages");
});

// The other half of the same guard: a plain text answer must NOT grow a second message whose only
// content is the "⏳ Working" liveness pulse.
test("a text-only turn never opens a card just to show a liveness pulse", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onDelta("A long answer that takes a while to write. ");
  t.mock.timers.tick(20_000);
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  progress.onDelta("Done.");
  await progress.finalize({ content: "A long answer that takes a while to write. Done." });

  assert.equal(taskUpdates(calls).length, 0, "a text-only turn stays one message with no toolbox");
});

// SLK-202. Slack APPENDS a task row's rich output, so a stage whose output rides the publishing
// chunk, the status flip and the terminal seal is rendered two or three times over.
test("a stage output is delivered once and never re-sent when the card is sealed", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  const step = (status) => ({
    kind: "report_progress",
    title: "Prepare release",
    steps: [{
      id: "collect",
      title: "Collect context",
      status,
      details: "Read the customer record.",
      output: "Three meetings found.",
      sources: [],
    }],
  });
  progress.onEvent(step("in_progress"));
  progress.onEvent(step("complete")); // same rich fields, only the status moved
  progress.onDelta("Ready.");
  await progress.finalize({ content: "Ready.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const carried = taskUpdates(calls).filter((task) => task.id === "report-collect" && task.output !== undefined);
  assert.equal(carried.length, 1, "exactly one chunk may carry the stage output");
  assert.equal(carried[0].output, "Three meetings found.");
  assert.equal(taskUpdates(calls).filter((task) => task.id === "report-collect" && task.details !== undefined).length, 1,
    "the same holds for the stage's details");
  const sealed = terminalTaskUpdates(calls).find((task) => task.id === "report-collect");
  assert.equal(sealed.status, "complete", "the seal still carries the row's terminal title/status");
  assert.equal("output" in sealed, false, "the seal must not append an already-delivered output");
  assert.equal(renderedRows(calls).get("report-collect").output, "Three meetings found.",
    "the finished card shows the output exactly once");
});

// A stage whose output GROWS (the stop path appends an interruption note to what the step already
// published) must send only the added tail — resending the whole value would render the original
// paragraph twice under Slack's append semantics.
test("a stage output that grows is delivered as the added tail only", async () => {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => calls.push(["postMessage", payload]), update: async () => {} },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({
    kind: "report_progress",
    title: "Prepare release",
    steps: [{ id: "deploy", title: "Deploy", status: "in_progress", details: "", output: "Deployed 3 services.", sources: [] }],
  });
  await progress.stop(); // interruptReport appends its note to the output already published

  const outputs = taskUpdates(calls)
    .filter((task) => task.id === "report-deploy" && task.output !== undefined)
    .map((task) => task.output);
  assert.equal(outputs[0], "Deployed 3 services.");
  assert.equal(outputs.length, 2, "only the publishing chunk and the growth carry an output");
  assert.match(outputs[1], /^\nInterrupted/, "the growth chunk carries only the appended tail");
  assert.equal(renderedRows(calls).get("report-deploy").output, "Deployed 3 services.\nInterrupted before completion.",
    "the card renders the published output once, with the interruption note appended to it");
});

// SLK-206. Slack rate-limited `chat.stopStream` ("Will retry in 30 seconds"). The classic fallback
// then posted the complete answer as a NEW message while the partial streamed one stayed in the
// thread — truncated mid-sentence, no footer — and the footer arrived as yet another message:
// four bot replies for one turn. The recovery now removes the partial copy and puts the footer on
// the answer it posts.
test("a rate-limited stopStream leaves exactly one answer message, with its footer", async () => {
  const calls = [];
  let streamSeq = 0;
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => {
      const id = ++streamSeq;
      const stream = {
        ts: `1720000000.00010${id}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => {
          calls.push(["stopStream", payload, id]);
          if (id === 2) {
            throw Object.assign(new Error("A rate limit was exceeded. Will retry in 30 seconds"), {
              data: { error: "ratelimited" },
            });
          }
        },
      };
      return stream;
    },
    chat: {
      postMessage: async (payload) => {
        calls.push(["postMessage", payload]);
        return { ts: "1720000000.000900" };
      },
      update: async (payload) => calls.push(["update", payload]),
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
  progress.onDelta("The answer that was still stream");
  await progress.finalize({
    content: "The answer that was still streaming when Slack said no.",
    durationMs: 5,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const deletes = calls.filter((call) => call[0] === "delete");
  assert.deepEqual(deletes.map((call) => call[1].ts), ["1720000000.000102"],
    "only the partial answer message is removed — never the progress card");
  const posts = calls.filter((call) => call[0] === "postMessage").map((call) => call[1]);
  assert.equal(posts.length, 1, "the classic recovery posts exactly one answer message");
  assert.ok(posts[0].text.startsWith("The answer that was still streaming when Slack said no."),
    "the surviving message carries the complete authoritative answer");
  assert.equal(posts[0].blocks[0].text.text, posts[0].text, "the answer rides the message as its own block");
  assert.deepEqual(posts[0].blocks.slice(1).map((block) => block.type), ["context", "actions"],
    "the run-stats footer and its controls ride the same message instead of a stats-only one");
  assert.ok(calls.some((call) => call[0] === "stopStream" && call[2] === 1 && call[1]?.chunks?.length),
    "the toolbox card is still sealed");
  assert.equal(calls.some((call) => call[0] === "update"), false, "no partial message is left to patch up");
});

// SLK-207. Under sustained Slack rate limiting every assistant.threads.setStatus call sleeps its
// own retry-after, and the terminal clear used to be appended to the tail of an UNBOUNDED serial
// chain that finalize() awaited BEFORE writing the answer. Turns whose engine had long finished
// were delivered tens of minutes later, or not at all. Delivery is never gated on the temporary
// status surface again — and the clear still happens.
test("a jammed assistant status never holds back the answer, and still clears afterwards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let releaseStatus;
  const rateLimited = new Promise((resolve) => { releaseStatus = resolve; });
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async (method, payload) => {
      calls.push(["apiCall", method, payload]);
      await rateLimited; // Slack is rate-limiting the status surface: this request does not return
    },
    chatStream: () => streamer,
    chat: {
      postMessage: async (payload) => calls.push(["postMessage", payload]),
      update: async (payload) => calls.push(["update", payload]),
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };
  const progress = startProgress("stream", client, "C_STATUS_JAM", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onDelta("The answer that must not wait.");

  const finalized = progress.finalize({
    content: "The answer that must not wait.",
    durationMs: 5,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  t.mock.timers.tick(5_000); // the bounded grace the terminal clear is raced against
  await finalized;

  const stop = calls.find((call) => call[0] === "stopStream");
  assert.ok(stop, "the answer is finalized while the status write is still stuck at Slack");
  assert.ok(stop[1]?.blocks?.length, "the delivered answer carries its run-stats footer");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "the native answer needed no fallback");
  assert.equal(calls.filter((call) => call[0] === "apiCall").length, 1,
    "the jammed write is the only status request outstanding — nothing piles up behind it");

  releaseStatus();
  await new Promise((resolve) => setImmediate(resolve));
  const statuses = calls.filter((call) => call[0] === "apiCall").map((call) => call[2].status);
  assert.equal(statuses.at(-1), "", "the terminal clear is still attempted once Slack answers");
});

// The other half of the same guard: the status queue holds ONE in-flight write and ONE pending
// slot, and the pending slot always carries the latest phase. A turn that changes phase fifty
// times while Slack is slow must cost one status request afterwards, not fifty.
test("rapid activity phases coalesce into one pending assistant status", async () => {
  const statuses = [];
  let release;
  const firstWrite = new Promise((resolve) => { release = resolve; });
  const client = {
    apiCall: async (_method, payload) => {
      statuses.push(payload.status);
      if (statuses.length === 1) await firstWrite; // stuck behind Slack's retry-after
    },
    chatStream: () => ({ ts: "1720000000.000100", append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => {}, update: async () => {} },
  };
  const progress = startProgress("stream", client, "C_STATUS_COALESCE", "111.222", { authorId: "U1", teamId: "T1" });
  assert.equal(statuses.length, 1, "the opening phrase is the write in flight");

  // Thinking summaries: a pure status phase, so this measures the status queue itself and not the
  // card's own (correctly bounded) re-assert after each durable append.
  for (let index = 0; index < 25; index += 1) {
    progress.onEvent({ kind: "thinking", summary: `option ${index}` });
  }
  assert.equal(statuses.length, 1, "no phase may open a second concurrent status request");

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.length, 2, "the superseded phases collapse into a single write");
  assert.match(statuses[1], /option 24/, "and that write carries the LATEST phase, never a stale one");

  await progress.stop();
  assert.deepEqual(statuses.slice(2), [""], "the terminal clear is the last write on the thread");
});

// SLK-208. Slack can complete a message's stream server-side (a window blown by rate limiting, or
// the undocumented age cap). Every later append then fails `message_not_in_streaming_state`: the
// old code set `failed`, dropped every remaining delta, and left a message ending mid-word with no
// footer under a red "Something went wrong". The card already reseeded in that case; the answer
// now does too.
test("an answer stream Slack ends mid-reply is reseeded into one complete, footered message", async () => {
  const calls = [];
  let streamSeq = 0;
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => {
      const id = ++streamSeq;
      return {
        ts: `1720000000.00010${id}`,
        append: async (payload) => {
          calls.push(["append", payload, id]);
          if (id === 1 && /completed/.test(payload?.markdown_text || "")) {
            throw Object.assign(new Error("message_not_in_streaming_state"), {
              data: { error: "message_not_in_streaming_state" },
            });
          }
        },
        stop: async (payload) => calls.push(["stopStream", payload, id]),
      };
    },
    chat: {
      postMessage: async (payload) => { calls.push(["postMessage", payload]); return { ts: "1720000000.000900" }; },
      update: async (payload) => calls.push(["update", payload]),
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  const answer = "The answer starts here and is completed after Slack ended the stream.";
  progress.onDelta("The answer starts here ");
  progress.onDelta("and is completed after Slack ended the stream.");
  await progress.finalize({ content: answer, durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const survivor = calls.filter((call) => call[0] === "append" && call[2] === 2)
    .map((call) => call[1].markdown_text || "").join("");
  assert.equal(survivor, `${answer}\n\n<@U1>`, "the replacement message carries the WHOLE answer, deltas included");
  const sealed = calls.find((call) => call[0] === "stopStream" && call[2] === 2);
  assert.ok(sealed?.[1]?.blocks?.length, "the footer lands on the surviving message");
  assert.deepEqual(calls.filter((call) => call[0] === "delete").map((call) => call[1].ts), ["1720000000.000101"],
    "the stranded partial is removed — exactly one answer message survives");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "no duplicate answer is posted beneath it");
});

// The same accident on the terminal write: the stream is gone by the time the footer is sent, so
// the reply would keep its text but never get a footer (and the fallback would post a second copy).
test("a stop that finds the answer stream already ended still lands one footered answer", async () => {
  const calls = [];
  let streamSeq = 0;
  const client = {
    apiCall: refuseStatus(),
    chatStream: () => {
      const id = ++streamSeq;
      return {
        ts: `1720000000.00010${id}`,
        append: async (payload) => calls.push(["append", payload, id]),
        stop: async (payload) => {
          calls.push(["stopStream", payload, id]);
          if (id === 1) {
            throw Object.assign(new Error("message_not_in_streaming_state"), {
              data: { error: "message_not_in_streaming_state" },
            });
          }
        },
      };
    },
    chat: {
      postMessage: async (payload) => { calls.push(["postMessage", payload]); return { ts: "1720000000.000900" }; },
      update: async (payload) => calls.push(["update", payload]),
      delete: async (payload) => calls.push(["delete", payload]),
    },
  };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();

  progress.onDelta("A complete answer.");
  await progress.finalize({ content: "A complete answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });

  const survivor = calls.filter((call) => call[0] === "append" && call[2] === 2)
    .map((call) => call[1].markdown_text || "").join("");
  assert.equal(survivor, "A complete answer.\n\n<@U1>", "the replacement carries the compiled answer");
  const sealed = calls.find((call) => call[0] === "stopStream" && call[2] === 2);
  assert.ok(sealed?.[1]?.blocks?.length, "and receives the footer the dead message could not take");
  assert.deepEqual(calls.filter((call) => call[0] === "delete").map((call) => call[1].ts), ["1720000000.000101"],
    "the dead message is removed instead of being left above the answer");
  assert.equal(calls.some((call) => call[0] === "postMessage"), false, "the classic fallback is not needed");
});

// ── Gateway notes about the turn itself (run.js announceAnswerNote) ───────────────────────────
// A note the ORCHESTRATOR writes (a model it had to substitute) is part of the answer, but a
// streamed answer is written from the live deltas — so a note only prepended to the finished
// `content` reaches nobody. It streams as the head of the message instead, and finalize()
// subtracts it from the authoritative content so it is delivered exactly once.
function streamedMarkdown(calls) {
  return calls
    .filter((call) => call[0] === "append" || call[0] === "stopStream")
    .map((call) => call[1]?.markdown_text || "")
    .join("");
}
function noteClient(calls) {
  const ok = async () => ({ ok: true });
  let seq = 0;
  return {
    apiCall: refuseStatus(calls),
    chatStream: () => {
      const id = `stream.${++seq}`;
      calls.push(["chatStream", { id }]);
      return {
        ts: id,
        append: async (payload) => { calls.push(["append", payload]); return { ok: true }; },
        stop: async (payload) => { calls.push(["stopStream", payload || {}]); return { ok: true }; },
      };
    },
    chat: {
      postMessage: async (payload) => { calls.push(["postMessage", payload]); return { ok: true, ts: `bot.${++seq}` }; },
      update: ok,
      delete: ok,
    },
  };
}
const NOTE = "⚠️ _gpt-nope was rejected before the turn started — using gateway default gpt-5.6._\n\n";

test("a gateway answer note is streamed at the head of the answer and never delivered twice", async () => {
  const calls = [];
  const progress = startProgress("stream", noteClient(calls), cardChannel(), "1730000000.000000", { authorId: "U_NOTE", dir: null });

  progress.onEvent({ kind: "answer_note", scope: "gateway", text: NOTE });
  await cardReady();
  progress.onDelta("The answer itself.");
  await progress.finalize({ content: `${NOTE}The answer itself.`, durationMs: 10, usage: { input_tokens: 4, output_tokens: 2 } });

  const text = streamedMarkdown(calls);
  assert.equal(text.match(/was rejected before the turn started/g).length, 1, `delivered once: ${JSON.stringify(text)}`);
  assert.ok(text.startsWith(NOTE), "the note leads the answer");
  assert.equal(text.match(/The answer itself\./g).length, 1, "and the answer is delivered once");
});

test("a tool-only turn still delivers its whole answer under the note", async () => {
  const calls = [];
  const progress = startProgress("stream", noteClient(calls), cardChannel(), "1730000001.000000", { authorId: "U_NOTE", dir: null });

  progress.onEvent({ kind: "answer_note", scope: "gateway", text: NOTE });
  await cardReady();
  // Nothing streams: the engine answered through tools and the reply arrives only on the result.
  await progress.finalize({ content: `${NOTE}Posted the chart.`, durationMs: 10, usage: { input_tokens: 4, output_tokens: 2 } });

  const text = streamedMarkdown(calls);
  assert.equal(text.match(/was rejected before the turn started/g).length, 1, `delivered once: ${JSON.stringify(text)}`);
  assert.equal(text.match(/Posted the chart\./g).length, 1, "the answer is not swallowed by the preface");
});

test("a gateway note that arrives after the answer began becomes a durable card row", async () => {
  const calls = [];
  const progress = startProgress("stream", noteClient(calls), cardChannel(), "1730000002.000000", { authorId: "U_NOTE", dir: null });

  progress.onDelta("Already writing.");
  await cardReady();
  progress.onEvent({ kind: "answer_note", scope: "gateway", text: "the configured model was substituted" });
  await progress.finalize({ content: "Already writing.", durationMs: 10, usage: { input_tokens: 4, output_tokens: 2 } });

  assert.ok(
    taskUpdates(calls).some((row) => /the configured model was substituted/.test(row.title || "")),
    "a note that can no longer lead the answer is kept as a card row rather than dropped",
  );
  assert.equal(streamedMarkdown(calls).match(/Already writing\./g).length, 1);
});

test("mutable numeric progress counts replace the title instead of accumulating rich details", async () => {
  const calls = [];
  const streamer = { ts: "1720000000.000100", append: async (p) => calls.push(["append", p]), stop: async (p) => calls.push(["stopStream", p]) };
  const client = { apiCall: refuseStatus(), chatStream: () => streamer, chat: { postMessage: async () => {}, update: async () => {} } };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1" });
  await cardReady();
  for (const count of [0, 2, 4]) {
    progress.onEvent({ kind: "report_progress", title: "Validate fixtures", steps: [{ id: "verify", title: "Verify", status: count === 4 ? "complete" : "in_progress", details: `${count}/4 batches checked`, output: `${count} checks passed`, sources: [] }] });
  }
  progress.onEvent({ kind: "report_progress", title: "Validate fixtures", steps: [{ id: "long", title: "Long stage title ".repeat(20), status: "complete", details: `${"Long context ".repeat(30)}4/4`, output: "", sources: [] }] });
  await progress.finalize({ content: "Four fixtures verified.", durationMs: 5, usage: {} });
  assert.match(renderedRows(calls).get("report-long").title, /4\/4/, "long prose cannot hide the current counter behind title truncation");
  const row = renderedRows(calls).get("report-verify");
  assert.equal(row.title, "Verify · 4/4 batches checked · 4 checks passed");
  assert.equal(row.details, "");
  assert.equal(row.output, "");
});

test("Stop releases its caller while a stream append is throttled and later seals partial text", async () => {
  const calls = [];
  let releaseAppend;
  let enteredAppend;
  const appended = new Promise((r) => { enteredAppend = r; });
  const streamer = {
    ts: "1720000000.000100",
    append: async (p) => { calls.push(["append", p]); enteredAppend(); await new Promise((r) => { releaseAppend = r; }); },
    stop: async (p) => calls.push(["stopStream", p]),
  };
  const client = { apiCall: refuseStatus(), chatStream: () => streamer, chat: { postMessage: async () => {}, update: async () => {} } };
  const progress = startProgress("stream", client, cardChannel(), "111.222", { authorId: "U1", teamId: "T1", stopGraceMs: 10 });
  progress.onDelta("Partial fixture answer");
  await appended;
  await progress.stop();
  assert.equal(calls.some(([kind]) => kind === "stopStream"), false, "cleanup is still waiting for the in-flight append");
  releaseAppend();
  for (let i = 0; i < 20 && !calls.some(([kind]) => kind === "stopStream"); i++) await new Promise((r) => setImmediate(r));
  assert.ok(calls.some(([kind, p]) => kind === "stopStream" && /Stopped — partial answer/.test(p.markdown_text)), "background cleanup retains partial-result semantics");
});
