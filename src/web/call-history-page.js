// Serialized into the Activity page; all call text is rendered as text, never HTML.
export function callHistoryBrowser(config, browser) {
  "use strict";
  const { document } = browser;
  const list = document.getElementById("call-history");
  const notice = document.getElementById("calls-status");
  const more = document.getElementById("calls-more");
  const refresh = document.getElementById("calls-refresh");
  let nextCursor = null, loading = false;
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const duration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    return (seconds >= 3600 ? Math.floor(seconds / 3600) + "h " : "") + Math.floor(seconds % 3600 / 60) + "m " + seconds % 60 + "s";
  };
  const cost = (value) => value === null ? "Cost outside your plan’s history window" : "~$" + value.toFixed(4) + " voice";
  async function request(path) {
    const response = await browser.fetch(config.base + path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "Your session or access has ended. Sign in again." : "Couldn’t load call history. Please try again.");
    return response.json();
  }
  function card(call) {
    const details = node("details"); details.className = "call-history-card";
    const heading = node("summary");
    const date = node("time", new Date(call.startedMs).toLocaleString()); date.dateTime = new Date(call.startedMs).toISOString();
    heading.append(date, node("span", duration(call.durationMs)), node("span", cost(call.costUSD)), node("span", call.threadCount + " thread" + (call.threadCount === 1 ? "" : "s")));
    details.append(heading);
    const content = node("div"); content.className = "call-history-detail"; details.append(content);
    let loaded = false, pending = false;
    async function loadDetail() {
      if (loaded || pending || !details.open) return;
      pending = true; content.textContent = "Loading summary…";
      try {
        const data = await request("/api/calls/" + encodeURIComponent(call.id));
        content.replaceChildren(node("h2", "Call summary"));
        const summary = node("p", data.summary); summary.className = "call-history-summary"; content.append(summary);
        if (data.reason) content.append(node("p", "Ended: " + data.reason));
        content.append(node("h2", "Threads visited"));
        if (!data.threads.length) content.append(node("p", "This call did not enter a thread."));
        else {
          const threads = node("ul");
          data.threads.forEach((thread, index) => {
            const item = node("li");
            const link = node("a", thread.channelName + (thread.title ? " — " + thread.title : "") + " · " + thread.threadTs);
            link.href = config.base + "/calls/" + encodeURIComponent(call.id) + "/thread/" + index;
            link.target = "_blank"; link.rel = "noopener noreferrer";
            item.append(link, node("span", " · " + duration(thread.durationMs) + " here"));
            threads.append(item);
          });
          content.append(threads);
        }
        loaded = true;
      } catch (error) {
        content.replaceChildren(node("p", error.message));
        const retry = node("button", "Retry summary"); retry.type = "button"; retry.addEventListener("click", loadDetail); content.append(retry);
      } finally { pending = false; }
    }
    details.addEventListener("toggle", loadDetail);
    return details;
  }
  async function load(reset = false) {
    if (loading) return;
    loading = true; more.disabled = true; refresh.disabled = true;
    notice.textContent = "Loading calls…";
    try {
      const data = await request("/api/calls" + (!reset && nextCursor ? "?before=" + encodeURIComponent(nextCursor) : ""));
      if (reset) list.replaceChildren();
      for (const call of data.calls) list.append(card(call));
      nextCursor = data.nextCursor; more.hidden = nextCursor === null;
      notice.textContent = list.children.length ? "" : "No calls recorded yet. Calls completed after this update will appear here.";
    } catch (error) { notice.textContent = error.message; }
    finally { loading = false; more.disabled = false; refresh.disabled = false; }
  }
  refresh.addEventListener("click", () => { void load(true); });
  more.addEventListener("click", () => { void load(); });
  void load(true);
}

export const CALL_HISTORY_CSS = `
.calls-page{max-width:1800px;width:100%;margin:0 auto;padding:24px 20px}
.calls-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.calls-copy,#calls-status{color:var(--muted);font-size:13px;margin:14px 0}
.call-history-card{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:12px 0;overflow:hidden}
.call-history-card>summary{display:flex;flex-wrap:wrap;gap:12px 24px;cursor:pointer;padding:18px;font-size:13px;list-style:revert}
.call-history-card>summary time{font-weight:600;flex:1;min-width:180px}
.call-history-card>summary:focus-visible{outline:2px solid var(--orange);outline-offset:-3px}
.call-history-detail{border-top:1px solid var(--line);padding:18px;font-size:14px;overflow-wrap:anywhere}
.call-history-detail h2{font-size:15px;margin:0 0 12px}
.call-history-detail h2:not(:first-child){margin-top:24px}
.call-history-summary{white-space:pre-wrap;line-height:1.6}
.call-history-detail ul{padding-left:20px;line-height:1.8}
.call-history-detail a{color:var(--orange);text-decoration:underline}
`;
