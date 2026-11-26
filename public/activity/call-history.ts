export interface CallListEntry {
  id: string;
  startedMs: number;
  durationMs: number;
  costUSD: number | null;
  threadCount: number;
}

interface CallList {
  calls: CallListEntry[];
  nextCursor: string | null;
}

interface CallDetail {
  summary: string;
  reason: string;
  threads: { channelName: string; title: string; threadTs: string; durationMs: number }[];
}

// Each shell supplies its own authenticated path. The immutable browser asset holds no session data.
function openCallsView(base: string) {
  const list = document.querySelector<HTMLElement>("#call-history");
  const notice = document.querySelector<HTMLElement>("#calls-status");
  const more = document.querySelector<HTMLButtonElement>("#calls-more");
  const refresh = document.querySelector<HTMLButtonElement>("#calls-refresh");
  if (!list || !notice || !more || !refresh) return;
  loadCallHistory(list, notice, more, refresh, base);
}

function loadCallHistory(list: HTMLElement, notice: HTMLElement, more: HTMLButtonElement, refresh: HTMLButtonElement, base: string) {
  let nextCursor: string | null = null;
  let loading = false;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  const duration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return (seconds >= 3600 ? Math.floor(seconds / 3600) + "h " : "") + Math.floor(seconds % 3600 / 60) + "m " + seconds % 60 + "s";
  };
  const cost = (value: number | null) => value === null ? "Cost outside your plan’s history window" : "~$" + value.toFixed(4) + " voice";
  async function request<T>(path: string): Promise<T> {
    const response = await fetch(base + path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "Your session or access has ended. Sign in again." : "Couldn’t load call history. Please try again.");
    return response.json();
  }
  function card(call: CallListEntry) {
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
        const data = await request<CallDetail>("/api/calls/" + encodeURIComponent(call.id));
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
            link.href = base + "/calls/" + encodeURIComponent(call.id) + "/thread/" + index;
            link.target = "_blank"; link.rel = "noopener noreferrer";
            item.append(link, node("span", " · " + duration(thread.durationMs) + " here"));
            threads.append(item);
          });
          content.append(threads);
        }
        loaded = true;
      } catch (error) {
        content.replaceChildren(node("p", error instanceof Error ? error.message : "Couldn’t load call history. Please try again."));
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
      const data = await request<CallList>("/api/calls" + (!reset && nextCursor ? "?before=" + encodeURIComponent(nextCursor) : ""));
      if (reset) list.replaceChildren();
      for (const call of data.calls) list.append(card(call));
      nextCursor = data.nextCursor; more.hidden = nextCursor === null;
      notice.textContent = list.children.length ? "" : "No calls recorded yet. Calls completed after this update will appear here.";
    } catch (error) { notice.textContent = error instanceof Error ? error.message : "Couldn’t load call history. Please try again."; }
    finally { loading = false; more.disabled = false; refresh.disabled = false; }
  }
  refresh.addEventListener("click", () => { void load(true); });
  more.addEventListener("click", () => { void load(); });
  void load(true);
}

const base = document.currentScript?.getAttribute("data-activity-base");
if (base) openCallsView(base);
