# NDJSON Streaming — Complete Reference

Newline-delimited JSON (NDJSON) over chunked HTTP is the streaming protocol for all AI responses. Each event is a JSON object followed by `\n`. No WebSockets needed.

---

## Backend: streaming route handler

```js
// src/app.js (or any route file)
import { createServer } from "node:http";

function sendNdjson(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

// POST /api/sessions/:sessionId/messages  (stream mode)
app.post("/api/sessions/:sessionId/messages", async (req, res, next) => {
  const { sessionId } = req.params;
  const { content, responseMode } = req.body;

  // ── active-run guard ──────────────────────────────────────────────────────
  if (activeRuns.has(sessionId)) {
    res.status(409).json({ error: "A run is already active for this session" });
    return;
  }
  activeRuns.set(sessionId, true);

  // ── set streaming headers BEFORE any data ────────────────────────────────
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();   // flush immediately so browser sees headers

  // ── initial event ─────────────────────────────────────────────────────────
  sendNdjson(res, { type: "start", sessionId, userMessage });

  try {
    const result = await runner.runStream({
      session,
      prompt: content,
      onDelta: (delta) => {
        sendNdjson(res, { type: "delta", delta });
      }
    });

    const assistantMessage = await finalizeAssistant({ ... });
    sendNdjson(res, { type: "done", assistantMessage });

  } catch (error) {
    const assistantMessage = await finalizeAssistant({ status: "error", ... });
    sendNdjson(res, { type: "error", error: error.message, assistantMessage });

  } finally {
    activeRuns.delete(sessionId);
    res.end();   // close the stream
  }
});
```

### Event type reference

| `type`          | When sent            | Key payload fields |
|-----------------|----------------------|--------------------|
| `start`         | Immediately          | `sessionId`, `userMessage?` |
| `delta`         | Each text chunk      | `delta: string` |
| `done`          | After final result   | `assistantMessage` |
| `error`         | On any error         | `error: string`, `assistantMessage?` |
| `section_ready` | After section write  | `sectionIndex`, `docIndex`, `title`, `content` |

**Design note:** Always send `done` or `error` before `res.end()`. Clients distinguish "ended cleanly" from "network drop" by whether they received one of these terminal events.

---

## Domain-specific streaming endpoint (document generation)

For multi-step document workflows where Claude generates one section at a time:

```js
// POST /api/quotes/:id/sections/:n/generate
router.post("/:id/sections/:n/generate", async (req, res, next) => {
  const quoteId = req.params.id;
  const sectionIndex = Number(req.params.n);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  sendNdjson(res, { type: "start", quoteId, sectionIndex });

  try {
    const { content, markerData } = await quoteRunner.generateSection({
      quoteId,
      sectionIndex,
      prompt: buildSectionPrompt({ section, sectionIndex }),
      onDelta: (delta) => sendNdjson(res, { type: "delta", delta })
    });

    sendNdjson(res, {
      type: "section_ready",
      sectionIndex,
      docIndex: section.docNumber,
      title: section.title,
      content,
      markerData
    });
  } catch (error) {
    sendNdjson(res, { type: "error", error: error.message });
  } finally {
    res.end();
  }
});
```

---

## Frontend: reading the NDJSON stream

```js
// utils.js
export async function readNdjsonStream(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process all complete lines in the buffer
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      handlers.onEvent(JSON.parse(line));
    }
  }
}
```

**Usage in a send-message handler:**

```js
async function sendMessage(content) {
  showAiWorking("Claude is thinking…");
  state.inFlight = true;

  // Optimistically append pending message
  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", content: "", status: "pending", mode: "stream" };
  appendMessage(assistantMessage);

  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, responseMode: "stream" })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "Streaming request failed");
    }

    await readNdjsonStream(response, {
      onEvent(event) {
        if (event.type === "delta") {
          assistantMessage.content += event.delta;
          upsertPendingAssistant(assistantMessage);
          return;
        }
        if (event.type === "done") {
          upsertPendingAssistant(event.assistantMessage);
          return;
        }
        if (event.type === "error") {
          upsertPendingAssistant({ ...event.assistantMessage, status: "error" });
          setStatus(event.error);
        }
      }
    });

  } catch (err) {
    assistantMessage.status = "error";
    assistantMessage.content = err.message;
    upsertPendingAssistant(assistantMessage);
  } finally {
    hideAiWorking();
    state.inFlight = false;
  }
}
```

---

## Full vs stream mode

The app supports both modes. Let the user choose (or auto-select based on use case):

```js
// Full mode: wait for complete response, then render
const payload = await requestJson(`/api/sessions/${sessionId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content, responseMode: "full" })
});
renderMessage(payload.assistantMessage);

// Stream mode: render as tokens arrive
const response = await fetch(...);
await readNdjsonStream(response, { onEvent });
```

**When to use full mode:** batch processing, background tasks, when the user doesn't need live feedback. **When to use stream mode:** interactive chat, long generation tasks, anywhere you want to show progressive output and avoid timeout anxiety.

---

## Error recovery

If a streaming request fails mid-stream (network drop, server crash), the `readNdjsonStream` loop exits when `done === true`. The client should check whether a terminal `done` or `error` event was received:

```js
let receivedTerminal = false;
await readNdjsonStream(response, {
  onEvent(event) {
    if (event.type === "done" || event.type === "error") receivedTerminal = true;
    // ...handle event
  }
});
if (!receivedTerminal) {
  // stream ended without a terminal event → treat as error
  setStatus("Connection lost. Please try again.");
}
```
