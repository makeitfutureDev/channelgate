# UI Patterns — Extended Reference

Patterns for building domain-specific views beyond the basic chat interface.

**Core layout rule:** All interfaces are chat-first. The chat pane is always on the RIGHT side — it's the primary surface where users see all AI messages, data, and replies. The left side holds domain content, controls, navigation, and wizards.

---

## Resume session button (required in every chat header)

Every active session must display a button that copies `claude --resume <session_id>` to the clipboard. This lets users jump into their terminal and continue the same Claude conversation outside the web UI — useful for debugging, manual file edits, or when the web app is insufficient.

```html
<div class="chat-header">
  <div class="chat-header-info">
    <span class="session-label">Session: <code id="sessionIdDisplay"></code></span>
  </div>
  <button id="copyResumeCmd" class="icon-button" title="Copy terminal resume command">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span class="copy-label">Copy CLI Resume</span>
  </button>
</div>
```

```js
const copyResumeCmd = document.getElementById("copyResumeCmd");
const copyLabel = copyResumeCmd.querySelector(".copy-label");

copyResumeCmd.addEventListener("click", () => {
  const cmd = `claude --resume ${currentSessionId}`;
  navigator.clipboard.writeText(cmd).then(() => {
    copyLabel.textContent = "Copied!";
    setTimeout(() => { copyLabel.textContent = "Copy CLI Resume"; }, 2000);
  });
});
```

```css
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.icon-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
  transition: background 150ms, color 150ms;
}
.icon-button:hover {
  background: var(--panel);
  color: var(--text);
}
```

---

## File upload with drag-and-drop + base64 encoding

The backend receives files as base64 JSON because multipart/form-data is harder to handle with the rest of the JSON API. Keep it consistent.

```html
<!-- Drop zone HTML -->
<div id="dropZone" class="drop-zone">
  <input type="file" id="fileInput" multiple style="display:none" />
  <div class="drop-zone-inner">
    <div class="drop-zone-icon">📎</div>
    <p>Drag & drop files here, or
      <button type="button" id="browseFilesButton" class="link-button">browse</button>
    </p>
    <p class="muted" style="font-size:0.85rem">PDFs, Word docs, text files, images, etc.</p>
  </div>
</div>
<div id="uploadFileList" class="file-list"></div>
```

```js
// File handling — collect into a pending list, encode on upload
const pendingFiles = [];

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // strip data: prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    pendingFiles.push(file);
    renderFileList();
  }
  // Show analyze button if files are present
  analyzeButton.style.display = pendingFiles.length > 0 ? "" : "none";
}

// Wire up drag-and-drop
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => addFiles(fileInput.files));
browseFilesButton.addEventListener("click", () => fileInput.click());

// Upload: encode all pending files and POST as JSON
async function uploadFiles(quoteId) {
  const encoded = await Promise.all(
    pendingFiles.map(async (file) => ({
      name: file.name,
      data: await readFileAsBase64(file)
    }))
  );
  return requestJson(`/api/quotes/${quoteId}/sources`, {
    method: "POST",
    body: JSON.stringify({ files: encoded })
  });
}
```

---

## Highlight-to-feedback tooltip

Let users highlight text in the rendered section content and attach targeted feedback to it. Collect these as "pending feedbacks" and include them in the next chat message.

```js
// Track pending feedbacks
const pendingFeedbacks = [];

// Listen for text selection in the section content pane
sectionContent.addEventListener("mouseup", () => {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || text.length < 5) return;

  // Position tooltip near the selection
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  feedbackTooltip.style.display = "";
  feedbackTooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
  feedbackTooltip.style.left = `${rect.left + window.scrollX}px`;
  tooltipHighlightPreview.textContent = `"${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`;
  tooltipHighlightPreview.style.display = "";
  currentHighlightedText = text;
});

addFeedbackButton.addEventListener("click", () => {
  const note = feedbackInput.value.trim();
  if (!note) return;

  pendingFeedbacks.push({ highlightedText: currentHighlightedText, note });
  feedbackInput.value = "";
  feedbackTooltip.style.display = "none";
  currentHighlightedText = "";
  renderPendingFeedbacks();
});

dismissTooltipButton.addEventListener("click", () => {
  feedbackTooltip.style.display = "none";
  currentHighlightedText = "";
});

function renderPendingFeedbacks() {
  pendingFeedbacksArea.style.display = pendingFeedbacks.length > 0 ? "" : "none";
  pendingFeedbacksList.innerHTML = "";
  pendingFeedbacks.forEach((fb, i) => {
    const item = document.createElement("div");
    item.className = "pending-feedback-item";
    item.innerHTML = `
      <span class="fb-text">${fb.highlightedText ? `"${fb.highlightedText.slice(0,40)}…"` : ""} ${fb.note}</span>
      <button type="button" class="remove-fb link-button danger-link" data-index="${i}">✕</button>
    `;
    pendingFeedbacksList.append(item);
  });
}

// Include feedbacks in the next send
async function sendChatWithFeedbacks(message) {
  const payload = { message, pendingFeedbacks: [...pendingFeedbacks], sectionIndex: currentSectionIndex };
  pendingFeedbacks.length = 0;
  renderPendingFeedbacks();
  // ... POST to /api/[domain]/:id/messages
}
```

---

## Section TOC with status badges

For document generation UIs: a sidebar TOC with real-time status indicators.

```js
function renderToc(sections, currentIndex) {
  tocList.innerHTML = "";
  for (const section of sections) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `toc-item toc-${section.status}`;
    if (section.index === currentIndex) item.classList.add("toc-current");
    item.innerHTML = `
      <span class="toc-status-dot"></span>
      <span class="toc-title">${section.index}. ${section.title}</span>
      <span class="toc-badge">${section.status}</span>
    `;
    item.addEventListener("click", () => navigateToSection(section.index));
    tocList.append(item);
  }
}
```

```css
/* Status dot colors via data/class */
.toc-pending    .toc-status-dot { background: var(--muted); }
.toc-generating .toc-status-dot { background: orange; animation: spin 0.9s linear infinite; }
.toc-ready      .toc-status-dot { background: var(--accent); }
.toc-approved   .toc-status-dot { background: #16a34a; }
```

Update after each section generation or approval by re-calling `renderToc()` with fresh metadata from the server.

---

## Brief/detail modal

A modal overlay for showing and editing a document brief or contextual summary.

```html
<div id="briefModal" class="brief-modal-overlay" style="display:none">
  <div class="brief-modal">
    <div class="brief-modal-header">
      <h3>Proposal Brief</h3>
      <button id="closeBriefModal" type="button" class="secondary-button">✕</button>
    </div>
    <div id="briefModalContent" class="brief-modal-content prose"></div>
    <div class="brief-modal-chat">
      <textarea id="briefChatInput" placeholder="Give feedback to update the brief… (Cmd+Enter to send)" rows="2"></textarea>
      <button id="briefChatSend" type="button" class="primary-button">Update</button>
    </div>
  </div>
</div>
```

```js
async function openBrief() {
  const { content } = await requestJson(`/api/quotes/${quoteId}/brief`);
  briefModalContent.innerHTML = marked.parse(content); // uses marked.js from CDN
  briefModal.style.display = "";
}

briefChatSend.addEventListener("click", async () => {
  const msg = briefChatInput.value.trim();
  if (!msg) return;
  showAiWorking("Updating brief…");
  const { content } = await requestJson(`/api/quotes/${quoteId}/brief`, {
    method: "POST",
    body: JSON.stringify({ message: msg })
  });
  briefModalContent.innerHTML = marked.parse(content);
  briefChatInput.value = "";
  hideAiWorking();
});

closeBriefModal.addEventListener("click", () => { briefModal.style.display = "none"; });
briefModal.addEventListener("click", (e) => { if (e.target === briefModal) briefModal.style.display = "none"; });
```

---

## Delete confirmation modal

Never delete immediately on click. Always confirm:

```html
<div id="deleteModal" class="brief-modal-overlay" style="display:none">
  <div class="brief-modal delete-modal">
    <div class="delete-modal-icon">🗑</div>
    <h3 id="deleteModalTitle">Delete Document?</h3>
    <p id="deleteModalBody" class="muted"></p>
    <div class="delete-modal-actions">
      <button id="deleteModalCancel" type="button" class="secondary-button">Cancel</button>
      <button id="deleteModalConfirm" type="button" class="danger-button">Delete</button>
    </div>
  </div>
</div>
```

```js
let pendingDeleteId = null;

function confirmDelete(id, label) {
  pendingDeleteId = id;
  deleteModalTitle.textContent = `Delete "${label}"?`;
  deleteModalBody.textContent = "This cannot be undone.";
  deleteModal.style.display = "";
}

deleteModalConfirm.addEventListener("click", async () => {
  if (!pendingDeleteId) return;
  await requestJson(`/api/quotes/${pendingDeleteId}`, { method: "DELETE" });
  deleteModal.style.display = "none";
  pendingDeleteId = null;
  await refreshList();
});

deleteModalCancel.addEventListener("click", () => {
  deleteModal.style.display = "none";
  pendingDeleteId = null;
});
```

---

## Multi-step wizard navigation

Step wizards (create flows) need clear back/next with state preserved between steps:

```js
let wizardState = { step: 1, clientName: "", uploadedFiles: [] };

function showStep(n) {
  for (const el of document.querySelectorAll(".create-step")) el.style.display = "none";
  document.getElementById(`createStep${n}`).style.display = "";
  wizardState.step = n;
  createTitle.textContent = stepTitles[n];
}

// Step 1 → 2: validate name, then show upload
toStep2Button.addEventListener("click", () => {
  wizardState.clientName = clientNameInput.value.trim();
  if (!wizardState.clientName) { setStatus("Enter a name first."); return; }
  showStep(2);
});

// Step 2 → 3: run AI analysis on files, pre-fill context fields
analyzeButton.addEventListener("click", async () => {
  showAiWorking("Analyzing files…");
  try {
    const { suggestions } = await requestJson("/api/quotes/suggest-context", {
      method: "POST",
      body: JSON.stringify({
        skillName: selectedSkill,
        clientName: wizardState.clientName,
        files: await encodeFiles(wizardState.uploadedFiles)
      })
    });
    renderContextFields(suggestions);
    showStep(3);
  } finally {
    hideAiWorking();
  }
});
```

---

## Shareable link / URL state

Allow bookmarking or sharing a specific view by encoding state in the URL hash:

```js
// Encode current view state into URL hash
function pushState(quoteId, sectionIndex) {
  history.replaceState(null, "", `#${quoteId}/${sectionIndex}`);
}

// On load: restore from hash
function restoreFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const [quoteId, sectionStr] = hash.split("/");
  if (quoteId) loadQuote(quoteId, Number(sectionStr) || 1);
}

window.addEventListener("load", restoreFromHash);
```

---

## CSS patterns

### Prose content area (Markdown rendered output)
```css
.prose {
  line-height: 1.7;
  max-width: 72ch;
}
.prose h1, .prose h2, .prose h3 { margin: 1.4em 0 0.5em; font-family: "Avenir Next Condensed", sans-serif; }
.prose p { margin: 0 0 1em; }
.prose ul, .prose ol { padding-left: 1.6em; margin: 0 0 1em; }
.prose table { border-collapse: collapse; width: 100%; margin: 1em 0; }
.prose th, .prose td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
.prose th { background: var(--panel-strong); }
```

### Status badges
```css
.status-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.status-badge[data-status="pending"]     { background: rgba(100,100,100,0.1); color: var(--muted); }
.status-badge[data-status="generating"] { background: rgba(234,179,8,0.15); color: #854d0e; }
.status-badge[data-status="ready"]      { background: rgba(15,118,110,0.12); color: var(--accent); }
.status-badge[data-status="approved"]   { background: rgba(22,163,74,0.12); color: #15803d; }
.status-badge[data-status="error"]      { background: rgba(166,60,45,0.1); color: var(--danger); }
```

### Split-pane layout (chat always on right)
```css
/* All views follow this pattern: left = content/controls, right = chat */
.generate-body {
  display: grid;
  grid-template-columns: 1fr 420px;  /* left: content, right: chat */
  gap: 20px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.section-pane {
  display: flex;
  flex-direction: column;
  overflow: auto;
  padding: 24px;
}

.chat-pane {
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

### Drop zone
```css
.drop-zone {
  border: 2px dashed var(--line);
  border-radius: 16px;
  padding: 32px;
  text-align: center;
  transition: border-color 150ms, background 150ms;
  cursor: pointer;
}
.drop-zone.drag-over {
  border-color: var(--accent);
  background: rgba(15, 118, 110, 0.05);
}
```
