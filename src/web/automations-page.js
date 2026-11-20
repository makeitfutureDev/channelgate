// Serialized into the Activity page's Automations view; all server text is rendered as text.
export function automationsBrowser(config, browser) {
  "use strict";
  const { document } = browser;
  const select = document.getElementById("automation-channel");
  const listEl = document.getElementById("automation-list");
  const notice = document.getElementById("automations-status");
  const refresh = document.getElementById("automations-refresh");
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const when = (iso) => iso ? new Date(iso).toLocaleString() : "";
  const STATUS = { succeeded: "Succeeded", "no-op": "Nothing to do", failed: "Failed", blocked: "Blocked", unreported: "Finished", interrupted: "Interrupted", skipped: "Skipped", queued: "Queued", running: "Running" };
  const duration = (ms) => { const s = Math.round((ms || 0) / 1000); return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; };
  async function request(path, init) {
    const response = await browser.fetch(config.base + path, { credentials: "same-origin", cache: "no-store", ...init });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "Your session or access to this conversation has ended." : response.status === 404 ? "That automation no longer exists." : "Couldn’t load automations. Please try again.");
    return response.json();
  }
  function runRow(run) {
    const li = node("li", undefined, "automation-run status-" + String(run.status || "").replace(/[^a-z-]/g, ""));
    li.append(node("strong", STATUS[run.status] || run.status || "Unknown"), node("span", when(run.startedAt)));
    if (run.durationMs) li.append(node("span", duration(run.durationMs)));
    if (typeof run.costUsd === "number") li.append(node("span", "~$" + run.costUsd.toFixed(4)));
    const text = run.error || run.summary;
    if (text) li.append(node("p", text));
    return li;
  }
  function card(a) {
    const details = node("details", undefined, "automation-card");
    const head = node("summary");
    head.append(node("span", a.title, "automation-title"), node("span", a.recurrence, "automation-recurrence"));
    const meta = node("span", (a.enabled ? (a.nextRun ? "Next: " + a.nextRun : "No upcoming run") : "Paused") + " · " + a.kind + (a.mine ? " · created by you" : ""), "automation-meta");
    head.append(meta);
    details.append(head);
    const body = node("div", undefined, "automation-detail");
    if (a.instructions) { body.append(node("h2", "Instructions")); body.append(node("p", a.instructions, "automation-instructions")); }
    const runsHead = node("h2", "Run history" + (a.runs.total ? " · " + a.runs.total + " run" + (a.runs.total === 1 ? "" : "s") + (a.runs.successRate === null ? "" : ", " + Math.round(a.runs.successRate * 100) + "% succeeded") : ""));
    const runs = node("ul", undefined, "automation-runs");
    body.append(runsHead, runs);
    if (a.canDelete) {
      const del = node("button", "Delete automation", "order-button automation-delete"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!browser.confirm("Delete “" + a.title + "”? It will stop running. Its run history is kept.")) return;
        del.disabled = true;
        try {
          await request("/api/automations/" + encodeURIComponent(select.value) + "/" + encodeURIComponent(a.id) + "/delete",
            { method: "POST", headers: { "Content-Type": "application/json", "X-CG-CSRF": config.csrf }, body: "{}" });
          details.remove(); notice.textContent = "Deleted “" + a.title + "”.";
        } catch (error) { notice.textContent = error.message; del.disabled = false; }
      });
      body.append(del);
    }
    details.append(body);
    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true; runs.replaceChildren(node("li", "Loading runs…"));
      try {
        const data = await request("/api/automations/" + encodeURIComponent(select.value) + "/" + encodeURIComponent(a.id) + "/runs");
        runs.replaceChildren(...(data.runs.length ? data.runs.map(runRow) : [node("li", "No runs recorded in the last 90 days.")]));
      } catch (error) { loaded = false; runs.replaceChildren(node("li", error.message)); }
    });
    return details;
  }
  async function loadChannel() {
    if (!select.value) return;
    notice.textContent = "Loading automations…"; listEl.replaceChildren();
    try {
      const data = await request("/api/automations/" + encodeURIComponent(select.value));
      listEl.replaceChildren(...data.automations.map(card));
      notice.textContent = data.automations.length ? "" : "No automations in this conversation.";
    } catch (error) { notice.textContent = error.message; }
  }
  async function loadChannels() {
    refresh.disabled = true; notice.textContent = "Loading conversations…";
    const previous = select.value;
    try {
      const data = await request("/api/automations");
      select.replaceChildren(...data.channels.map((c) => { const o = node("option", c.name + " (" + c.count + ")"); o.value = c.channelId; return o; }));
      if (!data.channels.length) { notice.textContent = "None of the conversations you can access has an automation yet."; return; }
      if (data.channels.some((c) => c.channelId === previous)) select.value = previous;
      await loadChannel();
    } catch (error) { notice.textContent = error.message; }
    finally { refresh.disabled = false; }
  }
  select.addEventListener("change", () => { void loadChannel(); });
  refresh.addEventListener("click", () => { void loadChannels(); });
  void loadChannels();
}

export const AUTOMATIONS_HTML = `<section class="calls-page automations-page" aria-label="Automations"><div class="calls-head"><h1>Automations</h1><button id="automations-refresh" class="order-button" type="button">Refresh</button></div><p class="calls-copy">Scheduled tasks, reminders and loops in the conversations you can access that have any. Your direct messages hold your personal ones.</p><label class="automation-picker">Conversation <select id="automation-channel"></select></label><p id="automations-status" role="status" aria-live="polite">Loading…</p><div id="automation-list"></div><noscript><p>Enable JavaScript to view automations.</p></noscript></section>`;

export const AUTOMATIONS_CSS = `
.automation-picker{display:flex;gap:10px;align-items:center;font-size:14px}
.automation-picker select{flex:1;min-width:0;max-width:420px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:inherit}
#automations-status{color:var(--muted);font-size:13px;margin:14px 0}
.automation-card{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:12px 0;overflow:hidden}
.automation-card>summary{display:flex;flex-wrap:wrap;gap:6px 20px;cursor:pointer;padding:16px 18px;font-size:13px;list-style:revert}
.automation-title{font-weight:600;flex:1 1 100%;font-size:14px}
.automation-recurrence{color:var(--orange)}
.automation-meta{color:var(--muted)}
.automation-detail{border-top:1px solid var(--line);padding:16px 18px;font-size:14px;overflow-wrap:anywhere}
.automation-detail h2{font-size:14px;margin:0 0 10px}
.automation-detail h2:not(:first-child){margin-top:20px}
.automation-instructions{white-space:pre-wrap;line-height:1.5;color:var(--muted)}
.automation-runs{list-style:none;padding:0;margin:0}
.automation-run{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.automation-run p{flex:1 1 100%;margin:2px 0 0;color:var(--muted);white-space:pre-wrap}
.automation-run.status-failed strong,.automation-run.status-blocked strong,.automation-run.status-interrupted strong{color:#e5484d}
.automation-delete{margin-top:18px}
`;
