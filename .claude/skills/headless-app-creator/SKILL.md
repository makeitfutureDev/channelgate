---
name: headless-app-creator
description: >
  Build a Claude Code headless app — Node.js + Express web backend OR native Swift/macOS app — that
  spawns the Claude CLI as a subprocess, streams responses over NDJSON or AsyncStream, and exposes a
  UI (vanilla JS or SwiftUI). Use this skill whenever the user wants to create a new headless AI app,
  add a streaming chat interface, implement a multi-step skill runner UI, build a self-learning AI
  app, design the working-directory contract between an app and a skill, or replicate this architecture
  pattern. Also trigger when the user mentions "headless Claude", "Claude subprocess", "AI chat web
  app", "NDJSON streaming", "session-based AI backend", "AI self-learning", "corrections loop",
  "skill decoupling", or "working directory contract".
---

# Headless App Creator

This skill covers the full architecture for building a **headless Claude web app** — a Node.js server that drives the Claude CLI as a subprocess and exposes it through a streaming HTTP API consumed by a vanilla JS frontend. The reference implementation lives at `~/Code/headless-app-with-cli`.

---

## Architecture overview

```
Browser (vanilla JS, ES modules)
  │  fetch → NDJSON stream
  ▼
Express server (Node.js ESM, no build step)
  │  spawn("claude", args, { stdio })
  ▼
Claude CLI subprocess
  (--output-format stream-json --verbose --include-partial-messages)
```

**Key principles:**
- The server is a thin wrapper. It manages sessions (JSON files on disk), spawns Claude per message, and pipes the stdout NDJSON events straight to the browser via a chunked HTTP response. No WebSockets, no React, no TypeScript compilation.
- **Chat-first**: Every interface is chat-first. The chat pane lives on the RIGHT side and is the primary surface — all AI messages, data, and replies appear there. The left side holds domain content, controls, and navigation.
- **Streaming + verbose by default**: Every app starts in streaming mode (`stream-json`) with `--verbose` and `--include-partial-messages` enabled. These are the baseline defaults — never use `json` as the default output format. The frontend loads directly into the chat view on startup, not a settings page or wizard. Users see the chat composer and can start talking immediately.
- **Actions-first development**: Build the backend first, then the frontend. The implementation order is always: (1) implement all Express routes, services, and Claude runner logic, (2) verify each route works via `curl` or a simple test script, (3) only then build the frontend UI and wire buttons/forms to the already-working endpoints. The frontend never defines business logic — it only calls backend routes that already exist and return correct responses. This prevents dead buttons, broken forms, and UIs that call non-existent endpoints.
- **Working folder isolation**: All Claude sessions run inside `~/.appname/`, a dedicated working folder created on startup. All user data, sessions, and processed files live there. Skills are copied from the bundled `skills/` dir into `~/.appname/.claude/skills/` on first run (existing skills are preserved so user customizations survive restarts). The `cwd` for every Claude subprocess is always `~/.appname/` — this means `cd ~/.appname && claude --resume <id>` works from the terminal.
- **Immediate file persistence**: User-uploaded files are saved to disk the moment they are dropped/pasted — never held only in browser memory as base64. Before the entity is created, files go to a draft folder (`_draft-<slug>/sources/`). On entity creation, draft files are moved into the real entity folder. This lets Claude read files from the filesystem directly (any format: PDF, DOCX, images) instead of receiving truncated base64 text.

---

## Platform choice: Web App vs Native macOS (Swift)

Both platforms share the same core idea — spawn Claude CLI as a subprocess, stream events, communicate via files. Choose based on deployment target.

| | **Web App (Node.js + Express)** | **macOS App (Swift + SwiftUI)** |
|---|---|---|
| **UI** | Vanilla JS, HTML, CSS in browser | SwiftUI views |
| **Streaming** | HTTP chunked NDJSON via `fetch` | `AsyncStream<ClaudeEvent>` |
| **Session process** | New `spawn()` per message | `PersistentClaudeSession` (stays alive) |
| **Credentials** | `~/.appname/references/.env` | Same `.env` + `EnvStore.bootstrap()` |
| **Event format** | Raw NDJSON JSON objects | Typed `enum ClaudeEvent { ... }` |
| **Token tracking** | `session.tokenUsage` object | `TokenUsage` struct |
| **Skill symlinks** | `~/.appname/.agents/skills/` | `~/.claude/skills/` + `~/.agents/skills/` |
| **Instructions** | Static `agent.md` symlinked into workdir | `CLAUDE.md` + `AGENTS.md` written on every launch |
| **Deployment** | Railway / Docker / any server | Xcode build → .app bundle |
| **Binary detection** | Assumes `claude` in PATH | Auto-detect across 5+ paths + UserDefaults override |

### Web App structure
```
Node.js server (Express)
  ├── src/server.js          # entry, creates workdir, starts Express
  ├── src/engines/claude.js  # spawn("claude", args) per message
  ├── src/routes/            # HTTP endpoints
  ├── src/services/          # session-store, workspace, env-store
  └── public/                # vanilla JS frontend (chat-first layout)
```

### macOS App structure
```
Xcode project (Swift)
  ├── ClaudeRunner.swift     # Process + Pipe + AsyncStream<ClaudeEvent>
  ├── PersistentClaudeSession.swift  # long-lived process, stdin/stdout
  ├── ClaudeEvent.swift      # typed event enum
  ├── SkillManager.swift     # deploy skills, write CLAUDE.md, symlinks
  ├── EnvStore.swift         # read/write references/.env
  ├── ProcessingEngine.swift # orchestrate runs, parse result.json
  ├── CorrectionStore.swift  # save user corrections as few-shot examples
  └── SwiftUI views          # TimelineView, ChatPanel, SettingsView
```

Both share the same **working directory contract** (section 21). The contract is platform-agnostic.

---

## File structure

```
project/                              # the app source directory
├── src/
│   ├── server.js              # entry: loads .env, creates working folder, wires deps, starts Express
│   ├── app.js                 # Express app factory (injected deps)
│   ├── engines/
│   │   └── claude.js          # Claude CLI subprocess runner
│   ├── routes/
│   │   ├── skills.js          # GET /api/skills, GET /api/skills/:name/schema
│   │   └── [domain].js        # domain-specific streaming routes
│   └── services/
│       ├── session-store.js   # read/write sessions inside working folder
│       ├── workspace.js       # working folder setup + symlink management
│       ├── engine-health.js   # check if `claude` binary is available
│       └── [domain]-store.js  # domain data (quotes, docs, etc.)
├── public/
│   ├── index.html             # chat-first UI (left: controls, right: chat)
│   ├── app.js                 # chat page module
│   ├── utils.js               # showAiWorking, hideAiWorking, readNdjsonStream, requestJson
│   └── styles.css             # shared styles + AI widget CSS
├── skills/                    # app's skills — bundled with the app, NOT in ~/.agents/skills/
│   └── <skill-name>/
│       └── SKILL.md           # skill definition with ## SCHEMA block
├── agent.md                   # app-level instructions for the AI agent (symlinked into working folder)
├── Dockerfile
└── package.json               # "type": "module", express only

~/.appname/                           # working folder (created on server startup)
├── .claude/
│   └── skills/                # skills COPIED from app's bundled skills/ on first run
│       └── <skill-name>/      # preserved across restarts (user may customize)
├── sessions/                  # one JSON file per session
├── [domain]/                  # domain-specific data (e.g. quotes/)
│   ├── <entity-id>/           # one folder per entity (proposal, report, etc.)
│   │   ├── sources/           # user-uploaded reference files (saved immediately on upload)
│   │   ├── sections/          # generated sections
│   │   └── meta.json          # entity metadata
│   └── _draft-<slug>/         # pre-creation uploads (moved into entity folder on create)
│       └── sources/
└── agent.md → <app-dir>/agent.md      # symlink to app's instructions
```

---

## 1. Backend: Claude CLI runner

See `references/claude-runner.md` for full implementation details.

**Core pattern:**

```js
// src/engines/claude.js
export function buildClaudeArgs({ prompt, sessionId, turnCount, permissionMode, outputFormat }) {
  const args = ["-p", prompt.trim()];
  if (turnCount === 0) args.push("--session-id", sessionId);
  else args.push("-r", sessionId);
  args.push("--output-format", outputFormat);
  if (outputFormat === "stream-json") args.push("--verbose", "--include-partial-messages");
  if (permissionMode === "full") args.push("--dangerously-skip-permissions");
  return args;
}
```

- First turn of a session: `--session-id <uuid>` (Claude creates the session)
- Subsequent turns: `-r <uuid>` (Claude resumes the session)
- Full mode: `--output-format json` → parse single JSON result
- Stream mode: `--output-format stream-json` → pipe stdout line-by-line, detect `content_block_delta` events

**Verbose event detection + delta forwarding in stream-json mode:**

The backend must forward **all** verbose events to the frontend so the activity pill can display them. Parse each NDJSON line from Claude's stdout and emit the appropriate event type:

```js
// Inside the line-by-line NDJSON handler for Claude's stdout
const payload = JSON.parse(line);

// Text deltas → forward as "delta" to the frontend
if (payload.type === "stream_event" && payload.event?.type === "content_block_delta") {
  const deltaText = payload.event?.delta?.text ?? "";
  if (deltaText) {
    assistantText += deltaText;
    sendNdjson(res, { type: "delta", delta: deltaText });
  }
}

// Verbose events → forward as "verbose" to the frontend for the activity pill
else if (payload.type === "stream_event") {
  const et = payload.event?.type;
  if (et === "message_start")       sendNdjson(res, { type: "verbose", event_type: "system_init", summary: payload.event?.message?.model || "" });
  else if (et === "content_block_start" && payload.event?.content_block?.type === "tool_use")
    sendNdjson(res, { type: "verbose", event_type: "tool_use", tool_name: payload.event?.content_block?.name });
  else if (et === "content_block_start" && payload.event?.content_block?.type === "thinking")
    sendNdjson(res, { type: "verbose", event_type: "thinking" });
  else if (et === "content_block_start" && payload.event?.content_block?.type === "text")
    sendNdjson(res, { type: "verbose", event_type: "writing" });
}
```

---

## 2. NDJSON streaming protocol

See `references/streaming.md` for full backend and frontend patterns.

**Event types:**

| type | direction | payload |
|------|-----------|---------|
| `start` | server→client | `{ sessionId?, userMessage? }` |
| `verbose` | server→client | `{ event_type, tool_name?, summary? }` — verbose events (thinking, tool_use, tool_result, writing) forwarded from Claude's stream-json output. Only sent when running in stream mode. |
| `delta` | server→client | `{ delta: string }` |
| `done` | server→client | `{ assistantMessage }` |
| `error` | server→client | `{ error: string, assistantMessage? }` |
| `section_ready` | server→client | `{ sectionIndex, docIndex, title, content }` |

**Backend send helper:**

```js
function sendNdjson(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}
```

Always set headers before any data: `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache`, `Connection: keep-alive`, call `res.flushHeaders?.()`.

**Active-run guard:** keep a `Map<sessionId, true>` to reject concurrent requests with `409 Conflict`.

---

## 3. Session store

Sessions are JSON files inside the working folder at `~/.appname/sessions/{sessionId}.json`:

```json
{
  "sessionId": "uuid",
  "engine": "claude",
  "permissionMode": "safe",
  "turnCount": 3,
  "transcript": [
    { "id": "uuid", "role": "user", "content": "...", "status": "completed", "mode": "stream", "createdAt": "iso" },
    { "id": "uuid", "role": "assistant", "content": "...", "status": "completed", "mode": "stream", "createdAt": "iso" }
  ],
  "createdAt": "iso",
  "updatedAt": "iso"
}
```

There is no per-session `workingDir` — all sessions use the app-level working folder (`~/.appname/`) as their `cwd`. This is set once in `server.js` and passed as `defaultWorkDir` to the app factory and routes. The frontend can optionally override it, but defaults to `~/.appname/`.

`appendMessage()` increments `turnCount`, pushes to `transcript`, rewrites the file. The transcript is passed to the Claude runner so it can reconstruct conversation context via `-r sessionId`.

---

## 4. Structured output markers

For multi-step document workflows, instruct Claude to end responses with a machine-readable marker:

```
SECTION_READY:{"sectionIndex":1,"docIndex":1,"title":"Executive Summary"}
TASK_LIST_READY:[{"title":"Section 1","docNumber":1,"referenceFile":"doc01.md"}, ...]
```

Parse at end of streamed content:

```js
const markerIdx = fullContent.lastIndexOf("\nSECTION_READY:");
if (markerIdx !== -1) {
  const before = fullContent.slice(0, markerIdx).trim();
  const markerLine = fullContent.slice(markerIdx + "\nSECTION_READY:".length).split("\n")[0].trim();
  const markerData = JSON.parse(markerLine);
  return { content: before, markerData };
}
```

This lets you keep the human-readable content separate from the structured signal — Claude writes the section, then appends the marker as a final line.

---

## 5. Frontend utilities (utils.js)

Essential exports — always put these in a shared `utils.js`:

### Activity pill (verbose event display)

See `references/ai-widget.md` for the complete HTML + CSS + JS. During streaming, a **single pill** appears in the chat that updates in-place as verbose events arrive. All detailed activity (thinking, tool use, tool results) accumulates in a hidden log behind the pill. The user can click the pill to expand and see the full log.

**Lifecycle:**
1. Before the fetch, insert an activity pill element into the chat (collapsed, gray, text: "Starting...")
2. As stream events arrive, update the pill's label text (e.g., "Thinking...", "Tool: Read...", "Writing...")
3. Append each verbose event to the pill's hidden activity log
4. When the stream ends:
   - If no tools were called → **remove the pill entirely** (nothing interesting to show)
   - If tools were called → set pill text to "N tool calls", change color to orange, keep the log expandable

**Pill HTML structure:**
```html
<div class="activity-pill" data-expanded="false">
  <button class="pill-header" onclick="togglePillLog(this)">
    <span class="pill-chevron">▸</span>
    <span class="pill-text">⏳ Starting...</span>
  </button>
  <div class="pill-log" hidden>
    <!-- log entries appended here as <div class="log-entry">...</div> -->
  </div>
</div>
```

**Pill CSS:**
```css
.activity-pill { margin: 4px 0; }
.pill-header {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 14px; border: none; cursor: pointer;
  border-radius: 999px; font-size: 12px;
  background: var(--pill-bg, rgba(128,128,128,0.1));
  color: var(--pill-color, #888);
  border: 1px solid var(--pill-border, rgba(128,128,128,0.2));
}
.activity-pill[data-color="orange"] { --pill-bg: rgba(255,165,0,0.1); --pill-color: #e88a00; --pill-border: rgba(255,165,0,0.25); }
.activity-pill[data-color="green"]  { --pill-bg: rgba(0,180,0,0.1);   --pill-color: #0a0;    --pill-border: rgba(0,180,0,0.25); }
.pill-chevron { font-size: 10px; transition: transform 0.15s; }
.activity-pill[data-expanded="true"] .pill-chevron { transform: rotate(90deg); }
.pill-log { padding: 6px 10px; font: 9px/1.4 monospace; color: #888; background: rgba(0,0,0,0.03); border-radius: 6px; margin-top: 4px; }
.log-entry { white-space: pre-wrap; word-break: break-all; }
```

**JS helpers:**
```js
// utils.js
export function createActivityPill() {
  const pill = document.createElement("div");
  pill.className = "activity-pill";
  pill.dataset.expanded = "false";
  pill.innerHTML = `
    <button class="pill-header" onclick="togglePillLog(this)">
      <span class="pill-chevron">▸</span>
      <span class="pill-text">⏳ Starting...</span>
    </button>
    <div class="pill-log" hidden></div>`;
  return pill;
}

export function updatePill(pill, { text, log, color }) {
  if (text) pill.querySelector(".pill-text").textContent = text;
  if (log) {
    const entry = document.createElement("div");
    entry.className = "log-entry";
    entry.textContent = log;
    pill.querySelector(".pill-log").appendChild(entry);
  }
  if (color) pill.dataset.color = color;
}

export function finalizePill(pill, toolCount) {
  if (toolCount === 0) { pill.remove(); return; }
  updatePill(pill, { text: `🔧 ${toolCount} tool call${toolCount === 1 ? "" : "s"}`, color: "orange" });
}

window.togglePillLog = function(btn) {
  const pill = btn.closest(".activity-pill");
  const log = pill.querySelector(".pill-log");
  const expanded = pill.dataset.expanded === "true";
  pill.dataset.expanded = String(!expanded);
  log.hidden = expanded;
};
```

**Handling verbose events in the stream reader:**
```js
// Inside your NDJSON event handler
let pill = null;
let toolCount = 0;

function handleEvent(event) {
  switch (event.type) {
    case "start":
      pill = createActivityPill();
      messagesEl.appendChild(pill);
      break;
    case "verbose":
      // Verbose events from --verbose mode: thinking, tool_use, tool_result, etc.
      if (!pill) break;
      const label = event.event_type === "thinking"  ? "💭 Thinking..."
                  : event.event_type === "tool_use"   ? `🔧 ${event.tool_name}...`
                  : event.event_type === "tool_result" ? "📥 Result..."
                  : event.event_type === "writing"     ? "✍️ Writing..."
                  : null;
      if (label) updatePill(pill, { text: label, log: event.summary || label });
      if (event.event_type === "tool_use") toolCount++;
      break;
    case "delta":
      if (pill) updatePill(pill, { text: "✍️ Writing..." });
      // ... append delta to assistant message as before
      break;
    case "done":
      if (pill) finalizePill(pill, toolCount);
      break;
  }
}
```

### NDJSON stream reader

```js
export async function readNdjsonStream(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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

### JSON request helper

```js
export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}
```

---

## 6. Frontend UI patterns

See `references/ui-patterns.md` for full details. Key decisions:

### Multi-view SPA (no router)

```html
<div id="view-list"     class="view" style="display:none">…</div>
<div id="view-create"   class="view" style="display:none">…</div>
<div id="view-generate" class="view" style="display:none">…</div>
```

```js
function showView(name) {
  for (const el of document.querySelectorAll(".view")) el.style.display = "none";
  document.getElementById(`view-${name}`).style.display = "";
}
```

Typical flow: `skills-select → list → create (multi-step wizard) → generate → verify → complete`

### Pending/optimistic messages

Immediately append a pending bubble before the API call completes, then update it as deltas stream in:

```js
function upsertPendingAssistant(message) {
  const existing = document.querySelector(`[data-message-id="${message.id}"]`);
  const node = existing || createMessageElement(message);
  node.classList.toggle("pending", message.status === "pending");
  node.querySelector(".message-body").textContent = message.content;
  if (!existing) messagesEl.append(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
```

Pending spinner via CSS `::after` on `.message.pending .message-body` (border animation).

### `<template>` for repeating elements

```html
<template id="messageTemplate">
  <article class="message">
    <div class="message-header">
      <span class="message-role"></span>
      <span class="message-mode"></span>
    </div>
    <pre class="message-body"></pre>
  </article>
</template>
```

```js
function createMessageElement(message) {
  const node = document.getElementById("messageTemplate").content.cloneNode(true).querySelector(".message");
  node.dataset.messageId = message.id;
  node.classList.add(message.role);
  node.querySelector(".message-body").textContent = message.content;
  return node;
}
```

### localStorage settings persistence

```js
const storageKeys = {
  engine: "app.engine",
  permissionMode: "app.permission-mode",
  outputFormat: "app.output-format",   // default: "stream-json"
  sessionId: "app.session-id"
};
// Defaults: outputFormat = "stream-json", permissionMode = "safe"
// On init: restore all keys (fall back to defaults); after each change: persist all keys
// Note: no workingDir — it's always ~/.appname/, set server-side
// On page load: show the chat view immediately — no landing page or wizard gate
```

### Chat-first layout (left: controls, right: chat)

Every interface follows the same pattern: **left side = domain content/controls, right side = chat**. The chat pane is the primary surface where users see all AI messages, data, and replies.

```css
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;  /* left: content, right: chat */
  min-height: 100vh;
  gap: 20px;
  padding: 20px;
}
.chat-pane {
  display: grid;
  grid-template-rows: auto 1fr auto; /* header / messages / composer */
  border-left: 1px solid var(--line);
}
.content-pane {
  overflow: auto;
}
```

Left pane: domain content, controls, session list, navigation, wizards. Right pane (chat): chat header with session info + resume button, scrollable messages, fixed-bottom composer with status text.

### Resume session button

Every active session must show a "Copy terminal command" button in the chat header. This lets the user resume the same Claude session in their terminal — useful for debugging, manual intervention, or continuing work outside the web UI.

```html
<div class="chat-header">
  <span class="session-label">Session: <code id="sessionIdDisplay"></code></span>
  <button id="copyResumeCmd" class="secondary-button" title="Copy terminal resume command">
    Copy CLI Resume
  </button>
</div>
```

```js
copyResumeCmd.addEventListener("click", () => {
  const cmd = `claude --resume ${currentSessionId}`;
  navigator.clipboard.writeText(cmd);
  copyResumeCmd.textContent = "Copied!";
  setTimeout(() => { copyResumeCmd.textContent = "Copy CLI Resume"; }, 2000);
});
```

The button copies `claude --resume <session_id>` to clipboard so the user can paste it directly into their terminal.

### Chat feedback pane (split-pane generate view)

For document generation UIs: left pane = rendered section content, right pane = chat (always). Users can highlight text in the left pane to attach targeted feedback to a chat message. Collect pending feedbacks as an array, send with the next chat message, and include them in the prompt to Claude as structured revision instructions.

---

## 7. Skills system

Skills live in `skills/<name>/SKILL.md` with a `## SCHEMA` section:

```markdown
## SCHEMA
```json
{
  "name": "my-skill",
  "label": "My Skill",
  "entityLabel": "Document",
  "contextFields": [
    { "id": "projectType", "label": "Project Type", "type": "select", "options": ["web", "mobile", "api"], "default": "web" },
    { "id": "scope", "label": "Project Scope", "type": "textarea" }
  ]
}
```
```

Server-side: read the SKILL.md file, extract text between `## SCHEMA` and the next `##` heading, parse the JSON code fence content, cache it. Expose via:
- `GET /api/skills` → list all skill names/labels
- `GET /api/skills/:name/schema` → full schema including `contextFields`

Skills are bundled in the app's `skills/` directory and **copied** into `~/.appname/.claude/skills/` on first startup. The workspace copy is the live version — users or AI can customize it without affecting the app source. Set `process.env.SKILLS_DIR` to the workspace skills path so all modules resolve from there. Skills are only copied if the destination folder doesn't exist yet (preserves user customizations across restarts).

---

## 8. Dockerfile (Railway/production)

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/
COPY agent.md ./agent.md
# Working folder is created at runtime by server.js at ~/.appname/
EXPOSE 3333
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
```

**Important:** `claude` CLI is installed globally in the image and authenticated via `ANTHROPIC_API_KEY` env var at runtime (Railway secrets / Docker env). The working folder (`~/.appname/`) is created at runtime by `server.js`. Mount a volume at the working folder path to persist sessions and generated documents across deploys.

Default port 3333 avoids conflicts with common local services (HubSpot MCP uses 3000).

---

## 9. package.json

```json
{
  "name": "my-headless-app",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "express": "^5.1.0"
  }
}
```

No build step. No TypeScript. No bundler. Just Node ESM. Add dependencies only as genuinely needed (e.g., `marked` for frontend Markdown rendering loaded via CDN).

---

## 10. Engine health check

```js
// src/services/engine-health.js
import { spawn } from "node:child_process";

export async function getEngineHealth() {
  const claude = await checkClaude();
  return { engines: { claude } };
}

async function checkClaude() {
  try {
    await runCommand("claude", ["--version"]);
    return { available: true };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}
```

Expose at `GET /api/health` and check on frontend init to show availability status.

---

## 11. Working folder setup

Every app gets a dedicated working folder at `~/.appname/` (e.g., `~/.proposals-makeitfuture/`). This folder is the single `cwd` for all Claude subprocess spawns and the home for all user data. The server creates it on startup.

**Key rule:** All Claude processes use `cwd = ~/.appname/`. This means `cd ~/.appname && claude --resume <session-id>` works from the terminal — the user can resume any session without knowing internal paths.

```js
// src/server.js — on startup
import { mkdir, readdir, cp } from "node:fs/promises";
import os from "node:os";

const rootDir = path.resolve(__dirname, "..");
const workDir = process.env.APP_DIR ?? path.join(os.homedir(), ".my-app");
const sessionsDir = path.join(workDir, "sessions");
const dataDir = path.join(workDir, "data");         // domain-specific (quotes, reports, etc.)
const skillsDir = path.join(workDir, ".claude", "skills");
const bundledSkillsDir = path.join(rootDir, "skills");

// Create workspace directories
await mkdir(sessionsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(skillsDir, { recursive: true });

// Copy bundled skills into workspace (skip if already present — user may have customized)
try {
  const entries = await readdir(bundledSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dest = path.join(skillsDir, entry.name);
    try { await readdir(dest); } catch {
      await cp(path.join(bundledSkillsDir, entry.name), dest, { recursive: true });
    }
  }
} catch {}

// Set SKILLS_DIR so all modules resolve from the workspace
process.env.SKILLS_DIR = skillsDir;

console.log(`Workspace: ${workDir}`);
```

**Why copy instead of symlink:** Skills in `~/.appname/.claude/skills/` are user-facing data — the user (or AI) may customize SKILL.md, add references, or adjust the schema. Copying preserves these changes across app updates. The bundled `skills/` directory in the app source is the seed; the workspace copy is the live version.

### Immediate file persistence (upload-to-disk pattern)

User-uploaded files are saved to disk the moment they arrive — never held only in browser memory as base64. This lets Claude read files directly from the filesystem (any format: PDF, DOCX, images, etc.) instead of receiving truncated base64 in the prompt.

**Flow:**
1. User drops/pastes files in the upload UI → frontend sends base64 to `POST /api/upload-sources`
2. Server saves to `~/.appname/data/_draft-<slug>/sources/<filename>` immediately
3. "Analyze" step tells Claude: `"Source files are saved at: <sourcesDir>. Read ALL files there."` — Claude reads from disk
4. On entity creation, draft files are moved into the real entity folder: `~/.appname/data/<entity-id>/sources/`
5. Draft folder is cleaned up

```js
// POST /api/upload-sources — save files to disk immediately (pre-creation)
router.post("/upload-sources", async (req, res, next) => {
  const { clientName, files } = req.body ?? {};
  const slug = clientName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const sourcesDir = path.join(dataDir, `_draft-${slug}`, "sources");
  await mkdir(sourcesDir, { recursive: true });

  const saved = [];
  for (const file of files) {
    if (!file.name || !file.data) continue;
    const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._\- ]/g, "_");
    await writeFile(path.join(sourcesDir, safeName), Buffer.from(file.data, "base64"));
    saved.push(safeName);
  }
  res.json({ saved, sourcesDir });
});
```

```js
// On entity creation — move draft sources into the real folder
const draftDir = path.join(dataDir, `_draft-${slug}`, "sources");
const realDir = path.join(dataDir, entityId, "sources");
try {
  for (const file of await readdir(draftDir)) {
    await rename(path.join(draftDir, file), path.join(realDir, file));
  }
  await rm(path.join(dataDir, `_draft-${slug}`), { recursive: true, force: true });
} catch {}
```

**Frontend — upload on drop/paste:**
```js
async function handleFileInputChange(fileList) {
  const files = await readFilesAsBase64(fileList);
  addUploadFiles(files);                    // update local UI list
  await requestJson("api/upload-sources", { // save to disk immediately
    method: "POST",
    body: JSON.stringify({ clientName, files })
  });
}
```

**What lives in the working folder:**
- `.claude/skills/` — skills copied from bundled `skills/` on first run
- `sessions/` — session JSON files (app metadata + transcript)
- `data/` — domain-specific entities, each with `sources/`, `sections/`, `meta.json`
- `data/_draft-<slug>/sources/` — pre-creation uploads (moved on create, cleaned up after)

---

## Reference files

- **`references/ai-widget.md`** — Complete AI thinking widget (HTML structure, full CSS with animations, JS show/hide utilities). Read this when implementing the loading indicator.
- **`references/streaming.md`** — Complete NDJSON streaming patterns for both backend route handlers and frontend fetch/read loop. Read this when wiring up a new streaming endpoint.
- **`references/claude-runner.md`** — Full `claude.js` engine implementation including subprocess spawning, line-by-line buffering, timeout handling, and stream delta extraction. Read this when implementing the Claude CLI wrapper.
- **`references/ui-patterns.md`** — Extended UI patterns: file upload with base64 encoding, highlight-to-feedback tooltip, section TOC with status badges, brief modal, delete confirmation modal, multi-step wizard navigation. Read this when building domain-specific views.

---

## 12. Structured response format (JSON contract)

Claude should **never** return freeform text as the primary output for machine-consumed runs. Every processing run ends with a structured JSON object — written inline or to a file. The app parses the JSON, not the text.

**Standard envelope:**
```json
{
  "message": "Human-readable summary of what was done.",
  "results": [...]
}
```

The field names are the **contract** — the one interface the app and skill share. Document the exact schema in the SKILL.md so Claude knows what to write and the app knows what to read.

**Inline extraction** — strip to first `{` ... last `}` to handle markdown fences:
```js
// Node.js
let jsonText = fullContent;
const start = jsonText.indexOf("{");
const end = jsonText.lastIndexOf("}");
if (start !== -1 && end !== -1) jsonText = jsonText.slice(start, end + 1);
const parsed = JSON.parse(jsonText);
```

```swift
// Swift
if let s = text.firstIndex(of: "{"), let e = text.lastIndex(of: "}") {
    jsonText = String(text[s...e])
}
```

**File fallback** — Claude sometimes writes to disk when output is large. Scan in order:
1. `~/workdir/result.json` — instruct Claude to always write here
2. `~/workdir/output_*.json` — alternative naming
3. `/tmp/*.json` modified within last 2 hours

```js
// Node.js fallback scan
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

function scanForOutput(workDir, schema) {
  const candidates = [
    join(workDir, "result.json"),
    ...readdirSync(workDir).filter(f => f.startsWith("output_") && f.endsWith(".json"))
      .map(f => join(workDir, f)),
    ...readdirSync(tmpdir()).filter(f => f.endsWith(".json"))
      .filter(f => Date.now() - statSync(join(tmpdir(), f)).mtimeMs < 7_200_000)
      .map(f => join(tmpdir(), f)),
  ];
  for (const path of candidates) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (schema.validate(data)) return data;
    } catch {}
  }
  return null;
}
```

---

## 13. .env for credentials — workdir/references/.env

All API keys and tokens live in `~/workdir/references/.env`. The app reads this file on startup and writes it when the user saves settings. **Never hardcode credentials. Never store them only in UserDefaults or localStorage.**

```
# ~/workdir/references/.env  (created as empty template on first launch)
ANTHROPIC_API_KEY=
CLICKUP_API_KEY=
CLICKUP_TEAM_ID=
SLACK_TOKEN=
```

**Why this file location:** Claude (running in the working directory) can read `references/.env` directly when it needs to call external APIs — without any involvement from the app. The skill and the app share credentials via the filesystem.

**Node.js bootstrap:**
```js
// src/services/env-store.js
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function bootstrapEnv(workDir) {
  const envPath = join(workDir, "references", ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, "ANTHROPIC_API_KEY=\n");
    return {};
  }
  return parseEnvFile(readFileSync(envPath, "utf8"));
}

export function persistEnv(workDir, values) {
  const envPath = join(workDir, "references", ".env");
  const existing = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, "utf8"))
    : {};
  const merged = { ...existing, ...values };
  writeFileSync(envPath, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function parseEnvFile(raw) {
  return Object.fromEntries(
    raw.split("\n")
      .filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
  );
}
```

**Swift bootstrap:**
```swift
// EnvStore.swift — call once at app launch
static func bootstrap() {
    let parsed = readEnvFile()  // parse KEY=VALUE lines
    for (envKey, udKey) in mapping {
        if let value = parsed[envKey], !value.isEmpty {
            UserDefaults.standard.set(value, forKey: udKey)
        }
    }
}
// .env is authoritative — always write settings back to it
static func persist() {
    var existing = readEnvFile()
    for (envKey, udKey) in mapping {
        existing[envKey] = UserDefaults.standard.string(forKey: udKey) ?? ""
    }
    writeEnvFile(existing)
}
```

---

## 14. Dual symlink architecture

Skills must be discoverable from **four locations** so Claude finds them regardless of which context it runs in (terminal, app, another agent):

```
~/.claude/skills/<name>             ← Claude Code global project skills
~/.agents/skills/<name>             ← Generic agent runtimes
~/workdir/.claude/skills/<name>     ← In-workdir Claude Code context
~/workdir/.agents/skills/<name>     ← In-workdir agent context
```

All four are symlinks to the **same real directory**. Updating the skill file once updates all contexts automatically.

```js
// workspace.js — extend ensureWorkspace()
import { mkdirSync } from "node:fs";
import { join, homedir } from "node:path";

function ensureGlobalSkillSymlinks(appSkillsDir, skillName) {
  ensureSymlink(join(appSkillsDir, skillName), join(homedir(), ".claude", "skills", skillName));
  ensureSymlink(join(appSkillsDir, skillName), join(homedir(), ".agents", "skills", skillName));
}
```

**CLAUDE.md and AGENTS.md must be written to workdir on every launch** (not just once). They source the skill instructions and tell Claude where credentials and data files are. This ensures Claude always sees the latest skill version:

```js
// Write on every server startup — idempotent
function writeWorkdirInstructions(workDir, appSkillsDir) {
  const skillContent = readSkillMd(appSkillsDir);  // strip YAML frontmatter
  const claudeMd = `# App Working Directory\n\n${skillContent}\n\n## Credentials\nLoad from \`references/.env\`.\n\n## Output\nAlways write final structured output to \`result.json\`.\n`;
  writeIfChanged(join(workDir, "CLAUDE.md"), claudeMd);
  writeIfChanged(join(workDir, "AGENTS.md"), claudeMd);  // same content, different name for other runtimes
}
```

---

## 15. Token tracking + cost per session

Parse the `result` event from Claude's stream-json output and accumulate totals per session. Show cost after each run so users can see what processing costs.

**Claude's result event:**
```json
{
  "type": "result",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_input_tokens": 890,
    "cache_creation_input_tokens": 0
  },
  "total_cost_usd": 0.0045
}
```

**Node.js — accumulate in session:**
```js
// In your NDJSON line handler
if (payload.type === "result" && payload.usage) {
  const u = payload.usage;
  session.tokenUsage = {
    inputTokens:         (session.tokenUsage?.inputTokens         ?? 0) + (u.input_tokens ?? 0),
    outputTokens:        (session.tokenUsage?.outputTokens        ?? 0) + (u.output_tokens ?? 0),
    cacheReadTokens:     (session.tokenUsage?.cacheReadTokens     ?? 0) + (u.cache_read_input_tokens ?? 0),
    cacheCreationTokens: (session.tokenUsage?.cacheCreationTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    costUSD:             (session.tokenUsage?.costUSD             ?? 0) + (payload.total_cost_usd ?? 0),
  };
  sendNdjson(res, { type: "token_usage", ...session.tokenUsage });
}
```

**Swift typed event:**
```swift
case tokenUsage(inputTokens: Int, outputTokens: Int,
                cacheReadTokens: Int, cacheCreationTokens: Int,
                costUSD: Double?)
```

**UI display** — show after each run:
```
Tokens: 1,234 in · 567 out · 890 cache read  |  Cost: $0.0045
```

Add to the `done` NDJSON event or emit separately. Always display — it builds trust and helps users understand what's happening.

---

## 16. Self-learning via CorrectionStore

When the user overrides the AI's answer in the review UI, save the correction. Feed it back as few-shot examples on the next run. Over time, Claude gets more accurate without model retraining.

**corrections.json format:**
```json
[
  {
    "signals": {
      "top_apps": ["Slack", "Chrome"],
      "urls": ["app.clickup.com/t/abc123"],
      "window_titles": ["Acme project planning"],
      "duration_mins": 45
    },
    "ai_answer": "wrong-task-id",
    "correct_answer": "correct-task-id",
    "correct_label": "Acme – Strategy",
    "recorded_at": "2026-03-21T14:30:00Z"
  }
]
```

**Node.js — save a correction:**
```js
// src/services/correction-store.js
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function recordCorrection(workDir, { signals, aiAnswer, correctAnswer, correctLabel }) {
  const path = `${workDir}/corrections.json`;
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];

  // Deduplicate: skip if same signals + same correct answer already recorded
  const isDuplicate = existing.some(c =>
    c.correct_answer === correctAnswer &&
    c.signals.top_apps?.some(a => signals.top_apps?.includes(a))
  );
  if (isDuplicate) return;

  existing.push({
    signals,
    ai_answer: aiAnswer,
    correct_answer: correctAnswer,
    correct_label: correctLabel,
    recorded_at: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(existing, null, 2));
}
```

**SKILL.md must instruct Claude to read corrections.json:**
```markdown
## Before matching
Read `corrections.json` if it exists. Treat each entry as an authoritative example:
if the current input has similar signals (same apps, URLs, window titles), strongly prefer
the `correct_answer` task from that entry over your own inference.
```

**The self-learning loop:**
```
Claude answers → user reviews → user corrects
      ↓
correction saved to corrections.json
      ↓
next run: Claude reads corrections as few-shot examples
      ↓
Claude answers better → fewer corrections needed
      ↓ (loop tightens over time)
```

No model fine-tuning. No retraining. Just a JSON file that grows smarter with use.

---

## 17. PersistentClaudeSession (native apps / high-frequency chat)

For native apps or high-frequency chat: keep one Claude process alive per session rather than spawning a new one per message. Send prompts via stdin, read from stdout in a loop.

**Swift implementation:**
```swift
// Keep process alive, send via stdin
final class PersistentClaudeSession {
    private let process: Process
    private let stdinHandle: FileHandle
    private let stdoutHandle: FileHandle
    private(set) var state: State = .ready
    enum State { case ready, busy, dead }

    static func launch(sessionArgs: [String], cwd: String, config: ClaudeRunner.Config) -> PersistentClaudeSession? {
        var args = ["--output-format", "stream-json", "--verbose"]
        args += sessionArgs
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.claudePath)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let stdinPipe = Pipe(); let stdoutPipe = Pipe()
        p.standardInput = stdinPipe; p.standardOutput = stdoutPipe
        do { try p.run() } catch { return nil }
        return PersistentClaudeSession(process: p,
            stdin: stdinPipe.fileHandleForWriting,
            stdout: stdoutPipe.fileHandleForReading)
    }

    func send(prompt: String) -> AsyncStream<ClaudeEvent> {
        guard isReady else { return AsyncStream { $0.finish() } }
        state = .busy
        return AsyncStream { continuation in
            Task.detached {
                self.stdinHandle.write((prompt.replacingOccurrences(of: "\n", with: " ") + "\n").data(using: .utf8)!)
                // read stdout in loop until .done event
                var buffer = ""
                while self.process.isRunning {
                    let chunk = self.stdoutHandle.availableData
                    if chunk.isEmpty { Thread.sleep(forTimeInterval: 0.01); continue }
                    buffer += String(data: chunk, encoding: .utf8) ?? ""
                    while let nl = buffer.firstIndex(of: "\n") {
                        let line = String(buffer[buffer.startIndex..<nl])
                        buffer.removeSubrange(buffer.startIndex...nl)
                        for event in ClaudeRunner.parseStreamEvents(line) {
                            continuation.yield(event)
                            if case .done = event { continuation.finish(); self.state = .ready; return }
                        }
                    }
                }
                continuation.finish()
            }
        }
    }

    var isReady: Bool { process.isRunning && state == .ready }
    func terminate() { state = .dead; if process.isRunning { process.terminate() } }
}
```

Auto-terminate after 1 hour of idle using a `DispatchWorkItem` timer reset on each `send()`.

**Node.js equivalent:** use a long-running child process with `stdio: ["pipe","pipe","pipe"]` and the same stdin/stdout loop pattern.

---

## 18. Typed event enum (native apps)

In native apps, replace raw NDJSON string forwarding with a typed enum. UI code switches on cases — no JSON parsing in the view layer.

```swift
enum ClaudeEvent {
    // Content
    case textDelta(String)
    case toolUse(name: String, input: [String: Any])
    case toolResult(toolUseId: String, content: String)
    case done(result: String)
    case error(String)
    // Status
    case systemInit(model: String)
    case thinking(text: String)
    case usingTool(name: String)
    case finishedToolUse
    case finishedEndTurn
    case writingResponse
    case rateLimitEvent
    case messageComplete
    case tokenUsage(inputTokens: Int, outputTokens: Int,
                    cacheReadTokens: Int, cacheCreationTokens: Int,
                    costUSD: Double?)
}
```

Parse the higher-level `assistant`/`user`/`result` message format (not just `content_block_delta`):

```swift
switch json["type"] as? String {
case "assistant":
    // parse content blocks: thinking, tool_use, text
case "user":
    // parse tool_result blocks
case "result":
    // extract result string + token usage + cost
case "error":
    // surface error message
}
```

---

## 19. File attachment via --file

For large inputs (CSV, data files), pass via `--file` instead of embedding in the prompt string:

```js
// Node.js
args.push("--file", filePath);
```

```swift
// Swift
args += ["--file", filePath]
```

Copy the input file into the working directory first so Claude can reference it with a relative path in subsequent tool calls. This also ensures Claude's file tools can read it without absolute path issues.

---

## 20. Binary auto-detection (native apps)

```swift
static func detected() -> Config {
    var c = Config()
    // Check UserDefaults for user-configured path first
    if let saved = UserDefaults.standard.string(forKey: "claudePath"),
       !saved.isEmpty,
       FileManager.default.fileExists(atPath: saved) {
        c.claudePath = saved; return c
    }
    let home = NSHomeDirectory()
    for path in [
        "\(home)/.claude-launcher/claude",
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        "\(home)/.npm-global/bin/claude",
        "\(home)/.local/bin/claude",
    ] {
        if FileManager.default.fileExists(atPath: path) {
            c.claudePath = path; break
        }
    }
    return c
}
```

Expose a path override in the Settings UI so users can point to a custom installation.

---

## 21. AI Self-Learning App Architecture

This is the full architecture pattern for apps where Claude's intelligence lives **outside** the app and improves over time without app updates.

### The core principle

```
┌─────────────────────────────────────────────────────────────┐
│                      THE CONTRACT                            │
│  App writes:  input files · .env credentials · corrections   │
│  Skill reads: those exact paths (documented in SKILL.md)     │
│  Skill writes: result.json (fixed schema, known field names) │
│  App reads:   result.json → parses to domain model           │
│  Neither side knows about the other's implementation         │
└─────────────────────────────────────────────────────────────┘
```

The app's job: manage files, spawn Claude, render UI, save corrections.
The skill's job: read data, reason, write structured output.

**The skill can be updated, rewritten, or replaced without touching one line of app code** — as long as the contract (input paths + output JSON schema) stays constant.

### Working directory layout

```
~/workdir/                          ← single integration point
├── references/
│   ├── .env                        ← credentials (app + skill both read this)
│   ├── task_cache.json             ← external data (written by sync scripts)
│   └── CC_*.md                     ← derived reference files (written by skill)
├── .claude/skills/<skill>/         ← symlink → real skill dir
├── .agents/skills/<skill>/         ← symlink → same real skill dir
├── CLAUDE.md                       ← written by app on launch (sources skill)
├── AGENTS.md                       ← written by app on launch (same content)
├── corrections.json                ← self-learning feedback loop
├── link-patterns/                  ← user-uploaded reference files
├── input.json                      ← processed input data
└── result.json                     ← Claude's structured output
```

### The full self-learning loop

```
Raw data (CSV, API, sensor)
         │
         ▼
[App] preprocess → write input.json to workdir
         │
         ▼
[Claude + Skill]  Read CLAUDE.md → load skill instructions
                  Read .env → credentials for external APIs
                  Read corrections.json → few-shot examples
                  Read link-patterns/ → URL/domain rules
                  Process input.json → match/classify/generate
                  Write result.json → structured output
         │
         ▼
[App] Parse result.json → show review UI
         │
         ├── User accepts → act (create entries, send emails, etc.)
         │
         └── User corrects → append to corrections.json
                                  │
                                  ▼
                  [Next run: Claude reads corrections → answers better]
```

### Skill update contract (zero-downtime)

```
Update SKILL.md
     ↓
App rewrites CLAUDE.md on next launch (idempotent)
     ↓
Next Claude run uses new instructions
     ↓
App reads result.json with same schema → no app change needed
```

**What CAN change in the skill without touching the app:**
- Matching rules, reasoning, disambiguation logic
- Python/script implementation (same output schema)
- Reference file formats (CC_*.md, link-patterns/)
- Step-by-step processing workflow

**What CANNOT change without an app update:**
- The JSON output schema field names
- The working directory path
- The credentials keys in .env

### Independence test

> Can a user open a terminal, `cd ~/workdir`, and run `claude` to reproduce what the app does?

If yes — the app is properly decoupled. CLAUDE.md in the workdir means Claude picks up the instructions automatically. The skill scripts are standalone. No app-specific state is needed.

### Full architecture diagram

```
┌──────────────────────────────────────────┐
│              APP SHELL                    │
│  UI · file I/O · subprocess runner       │
│  corrections · settings · token display  │
│  Language: Swift / Node.js / any         │
└────────────────┬─────────────────────────┘
                 │ reads/writes files
                 ▼
┌──────────────────────────────────────────┐
│           WORKING DIRECTORY              │
│  ~/workdir/  ← THE CONTRACT LAYER        │
│  .env · input.json · corrections.json    │
│  result.json · CLAUDE.md                 │
│  .agents/skills/ (symlinks)              │
└────────────────┬─────────────────────────┘
                 │ cwd = workdir
                 ▼
┌──────────────────────────────────────────┐
│           CLAUDE + SKILL                 │
│  Reads CLAUDE.md → instructions          │
│  Reads .env → credentials                │
│  Reads corrections.json → few-shot       │
│  Processes data → writes result.json     │
│  Runnable from: app · terminal · cron    │
└────────────────┬─────────────────────────┘
                 │ skill is a symlink to
                 ▼
┌──────────────────────────────────────────┐
│           SKILL DIRECTORY                │
│  ~/.agents/skills/<name>/SKILL.md        │
│  ~/.agents/skills/<name>/scripts/*.py    │
│  ~/.agents/skills/<name>/references/     │
│  ← Update here only. All contexts update │
└──────────────────────────────────────────┘
```
