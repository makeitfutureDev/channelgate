import { api } from "./admin-api.js";
import { escapeHtml as esc } from "./admin-view.js";

const RANGES = ["live", "1h", "24h", "7d", "30d"];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const number = (value, digits = 1) => finite(value) ? value.toFixed(digits) : "—";
const percent = (value) => finite(value) ? `${number(value)}%` : "—";
const time = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : "—";
export function healthBytes(value) {
  if (!finite(value)) return "—";
  const unit = value >= 1024 ** 4 ? 4 : value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${number(value / 1024 ** unit)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
export function storageSeverity(value) { return !finite(value) ? "unknown" : value >= 95 ? "critical" : value >= 85 ? "warning" : "normal"; }

// One cancellable batch at a time. Navigation, visibility, pause and range changes invalidate
// earlier responses even if the transport ignores AbortSignal. Timers begin after completion.
export function createHealthPoller({ request = api, onUpdate, visible = () => !document.hidden, schedule = setTimeout, unschedule = clearTimeout, now = Date.now }) {
  let active = false, paused = false, range = "live", generation = 0, timer = null, flight = null, controller = null, pending = false, manual = false, lastFull = 0;
  let data = { current: null, history: null, storage: null, hardware: null, errors: {} };
  const publish = () => onUpdate({ ...data, range, paused, loading: !!flight });
  function invalidate() {
    generation++;
    unschedule(timer);
    timer = null;
    controller?.abort();
  }
  async function run() {
    if (!active || !visible() || flight || (!pending && paused)) return;
    pending = false;
    const version = generation, selectedRange = range, refreshHardware = manual;
    manual = false;
    const full = refreshHardware || !lastFull || now() - lastFull >= 60_000;
    controller = new AbortController();
    const options = { signal: controller.signal };
    const jobs = [["current", "/api/system-health/current", options]];
    if (full) {
      jobs.push(["history", `/api/system-health/history?range=${selectedRange}`, options]);
      jobs.push(["storage", "/api/system-health/storage", options]);
      jobs.push(["hardware", `/api/system-health/hardware${refreshHardware ? "/refresh" : ""}`, { ...options, ...(refreshHardware ? { method: "POST" } : {}) }]);
    }
    flight = Promise.allSettled(jobs.map(([, url, opts]) => Promise.resolve().then(() => request(url, opts))));
    publish();
    const results = await flight;
    flight = null;
    if (version === generation && active && visible()) {
      const errors = { ...data.errors };
      results.forEach((result, index) => {
        const key = jobs[index][0];
        if (result.status === "fulfilled") { data[key] = result.value; delete errors[key]; }
        else if (result.reason?.name !== "AbortError") errors[key] = result.reason?.message || "Request failed";
      });
      data.errors = errors;
      if (full && results.every((result) => result.status === "fulfilled")) lastFull = now();
      publish();
    }
    if (pending) { run(); return; }
    if (version !== generation && active && visible()) publish();
    if (active && visible() && !paused) timer = schedule(run, 5_000);
  }
  function reload({ hardware = false, full = true } = {}) {
    invalidate();
    if (full) lastFull = 0;
    pending = true;
    manual ||= hardware;
    run();
  }
  return {
    enter() { active = true; reload(); },
    leave() { active = false; pending = false; manual = false; invalidate(); },
    visibilityChanged() { invalidate(); if (active && visible() && !paused) { pending = true; lastFull = 0; run(); } },
    togglePause() { paused = !paused; pending = false; manual = false; invalidate(); publish(); if (!paused) reload(); },
    setRange(value) { if (!RANGES.includes(value) || range === value) return; range = value; data.history = null; publish(); reload(); },
    refresh() { reload({ hardware: true }); },
  };
}

function meter(value, tone = "") { return `<div class="sh-meter ${tone}"><span style="width:${finite(value) ? Math.min(100, Math.max(0, value)) : 0}%"></span></div>`; }
function metric(label, value, detail, meterValue, tone = "", state = "") {
  return `<article class="sh-metric"><div class="sh-metric-top"><span>${label}</span><small class="${tone}">${esc(state)}</small></div><strong class="sh-metric-value">${esc(value)}</strong><div class="sh-metric-detail">${esc(detail)}</div>${meter(meterValue, tone)}</article>`;
}
function pairs(rows) { return `<dl class="sh-facts">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value ?? "—")}</dd>`).join("")}</dl>`; }
export function forecastCopy(forecast) {
  if (!forecast || ["insufficient_data", "insufficient_history"].includes(forecast.status)) return { title: "Building the storage trend", detail: "Not enough measured history for a capacity forecast yet." };
  if (forecast.status === "full") return { title: "Storage is full", detail: "Free space or increase capacity." };
  if (finite(forecast.daysToFull)) return { title: `About ${Math.max(0, Math.round(forecast.daysToFull))} days to capacity`, detail: `${healthBytes(forecast.bytesPerDay)} growth per day over ${number(forecast.observedDays, 0)} measured days. Estimate assumes the same growth and capacity.` };
  if (["stable", "declining", "no_growth"].includes(forecast.status)) return { title: "No projected capacity limit", detail: `Measured usage is stable or declining across ${number(forecast.observedDays, 0)} days. Future growth can change this.` };
  return { title: "Forecast unavailable", detail: "A reliable projection is not available for the collected history." };
}

// Time is the horizontal scale: irregular samples and missing observations never become
// evenly spaced synthetic history. Missing metrics break paths instead of plotting zero.
export function healthChart(points = [], { storage = false, start, end } = {}) {
  const usable = points.filter((p) => finite(p.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  if (!usable.length) return '<p class="sh-chart-empty">No observations in this period yet.</p>';
  const from = finite(start) ? start : usable[0].timestamp;
  const to = finite(end) && end > from ? end : Math.max(from + 1, usable.at(-1).timestamp);
  const width = 720, height = storage ? 170 : 260, left = 38, right = 12, top = 14, bottom = 24;
  const x = (t) => left + (t - from) / (to - from) * (width - left - right);
  const y = (v) => top + (1 - Math.min(100, Math.max(0, v)) / 100) * (height - top - bottom);
  const fields = storage ? [["storagePercent", "disk", "Storage"]] : [["cpuPercent", "cpu", "CPU"], ["memoryPercent", "memory", "RAM"]];
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" class="sh-grid-line"/><text x="0" y="${y(v) + 3}" class="sh-axis-label">${v}%</text>`).join("");
  const paths = fields.map(([field, cls]) => {
    let pen = false, previous = null;
    const typicalGap = storage ? 3 * 86_400_000 : Math.max(finite(start) ? 120_000 : 15_000, (to - from) / 120);
    const path = usable.map((point) => {
      if (!finite(point[field])) { pen = false; return ""; }
      const move = !pen || previous !== null && point.timestamp - previous > typicalGap;
      pen = true; previous = point.timestamp;
      return `${move ? "M" : "L"}${x(point.timestamp).toFixed(2)},${y(point[field]).toFixed(2)}`;
    }).join(" ");
    return `<path class="sh-line sh-${cls}" d="${path}"/>`;
  }).join("");
  const targets = usable.map((point) => {
    const label = `${time(point.timestamp)} · ${fields.map(([field, , name]) => `${name} ${percent(point[field])}`).join(" · ")}${storage ? ` · ${healthBytes(point.storageUsedBytes)} used` : ""}`;
    const dots = fields.filter(([field]) => finite(point[field])).map(([field, cls]) => `<circle cx="${x(point.timestamp)}" cy="${y(point[field])}" r="2.2" class="sh-dot sh-${cls}"/>`).join("");
    return `<g><title>${esc(label)}</title>${dots}<rect x="${x(point.timestamp) - 4}" y="${top}" width="8" height="${height - top - bottom}" fill="transparent"/></g>`;
  }).join("");
  return `<svg class="sh-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${storage ? "Storage" : "CPU and RAM"} usage over time">${grid}${paths}${targets}</svg><div class="sh-axis-foot"><span>${esc(new Date(from).toLocaleDateString())} ${storage ? "" : esc(new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span><span>${esc(new Date(to).toLocaleDateString())} ${storage ? "" : esc(new Date(to).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span></div><div class="sh-tooltip" hidden></div>`;
}

function installTooltip(host, points, storage) {
  const svg = host.querySelector("svg"), tip = host.querySelector(".sh-tooltip");
  if (!svg || !tip || !points?.length) return;
  const targets = [...svg.querySelectorAll("g")];
  targets.forEach((target, i) => {
    const show = (event) => {
      tip.textContent = target.querySelector("title").textContent;
      tip.hidden = false;
      const rect = host.getBoundingClientRect();
      tip.style.left = `${Math.max(0, Math.min(rect.width - Math.min(220, rect.width), (event.clientX || rect.left + rect.width / 2) - rect.left))}px`;
      tip.style.top = "20px";
    };
    target.addEventListener("pointermove", show);
    target.addEventListener("pointerleave", () => { tip.hidden = true; });
    // One focusable chart; arrows navigate observations without hundreds of tab stops.
    if (i === 0) {
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("aria-label", `${storage ? "Storage" : "CPU and RAM"} usage. Use left and right arrows for observations.`);
    }
  });
  let selected = targets.length - 1;
  svg.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") { tip.hidden = true; return; }
    selected = Math.max(0, Math.min(targets.length - 1, selected + (event.key === "ArrowLeft" ? -1 : 1)));
    tip.textContent = targets[selected].querySelector("title").textContent;
    tip.hidden = false; tip.style.left = "38px"; tip.style.top = "20px";
  });
  svg.addEventListener("blur", () => { tip.hidden = true; });
}

function hardwareMarkup(data) {
  if (!data?.snapshot) return '<p class="sh-muted">Hardware inventory has not been collected yet.</p>';
  const h = data.snapshot;
  // Hardware values are escaped at the display boundary; missing optional Linux interfaces
  // are explicit unknowns and never replaced with the prototype's server specification.
  const groups = [
    ["Processor", h.cpuModel, [["Architecture", h.architecture], ["Sockets", h.sockets], ["Physical cores", h.physicalCores], ["Logical CPUs", h.logicalCpus]]],
    ["Memory", healthBytes(h.memoryTotalBytes), [["Swap", healthBytes(h.swapTotalBytes)], ["DIMM details", "Not collected"]]],
    ["Operating system", h.osName, [["Kernel", h.kernel], ["Filesystem", h.filesystem]]],
    ["Mainboard", h.boardName, [["Vendor", h.boardVendor], ["BIOS", [h.biosVendor, h.biosVersion].filter(Boolean).join(" ")]]],
  ];
  return `<div class="sh-hardware-grid">${groups.map(([label, model, rows]) => `<div class="sh-hardware-group"><span class="sh-kicker">${label}</span><strong>${esc(model || "Not exposed by Linux")}</strong>${pairs(rows)}</div>`).join("")}</div>
    <div class="sh-device-grid"><div><h4>Storage devices</h4>${h.disks?.length ? h.disks.map((d) => `<div class="sh-device"><strong>${esc(d.model || d.name)}</strong><span>${esc([d.name, healthBytes(d.sizeBytes), d.rotational === true ? "HDD" : d.rotational === false ? "SSD" : null].filter(Boolean).join(" · "))}</span></div>`).join("") : '<p class="sh-muted">No physical disk details exposed by Linux.</p>'}</div><div><h4>Network & graphics</h4><p class="sh-muted">${esc(h.network?.map((n) => typeof n === "string" ? n : n.name).join(", ") || "Network inventory unavailable")}</p><p class="sh-muted">${esc(h.gpus?.map((g) => typeof g === "string" ? g : [g.vendor, g.device, g.driver].filter(Boolean).join(" ")).join(", ") || "Graphics inventory unavailable")}</p></div></div>
    <p class="sh-muted">Scanned ${esc(time(data.collectedAt))}. Inventory refreshes every 5 minutes and on manual refresh. Only devices exposed by Linux are shown.</p>
    ${data.changes?.length ? `<details class="sh-changes"><summary>Recent hardware changes (${data.changes.length})</summary><ul>${data.changes.map((change) => `<li>${esc(time(change.timestamp))} · ${esc(change.fields?.join(", "))}</li>`).join("")}</ul></details>` : '<p class="sh-muted">No hardware changes recorded.</p>'}`;
}

let view = null;
export function setSystemHealthActive(active) {
  // Async admin bootstrap can finish after the user has already navigated elsewhere.
  active = active && document.getElementById("view-system-health")?.classList.contains("active");
  if (!view && active) view = mountSystemHealth(document.getElementById("view-system-health"));
  if (active) view?.enter(); else view?.leave();
}
function mountSystemHealth(root) {
  root.innerHTML = `<div class="view-head sh-head"><div><p class="sh-eyebrow">Infrastructure</p><h2>System health</h2><p class="hint">Live host resources, 30-day performance history, and six months of storage trends.</p></div><div class="sh-actions"><span id="sh-status" class="sh-status" role="status">Connecting…</span><button type="button" class="ghost" id="sh-pause">Pause</button><button type="button" class="ghost" id="sh-refresh">Refresh</button></div></div>
    <div id="sh-error" class="sh-notice" role="status" hidden></div><div id="sh-metrics" class="sh-metrics"></div><div id="sh-storage-alert" class="sh-notice" role="status" hidden></div>
    <div class="sh-toolbar"><div class="sh-ranges" role="group" aria-label="Resource history period">${RANGES.map((range) => `<button type="button" data-range="${range}" aria-pressed="${range === "live"}">${range === "live" ? "Live" : range}</button>`).join("")}</div><span id="sh-updated" class="sh-muted">Waiting for the first sample…</span></div>
    <div class="sh-charts"><article class="sh-panel sh-resource-panel"><div class="sh-card-head"><div><h3>Resource usage</h3><p id="sh-period" class="sh-muted"></p></div><div class="sh-legend"><span class="sh-cpu">CPU</span><span class="sh-memory">RAM</span></div></div><div id="sh-resource-chart" class="sh-chart"></div></article><article class="sh-panel"><div class="sh-card-head"><div><h3>Storage trend</h3><p class="sh-muted">Last six months · recorded observations</p></div><span class="sh-legend sh-disk">Used</span></div><div id="sh-storage-chart" class="sh-chart sh-chart-small"></div></article><article class="sh-panel sh-forecast"><span class="sh-kicker">Capacity forecast</span><h3 id="sh-forecast-title"></h3><p id="sh-forecast-detail" class="sh-muted"></p></article></div>
    <div class="sh-detail-grid"><article class="sh-panel"><h3>Selected-period peaks</h3><div id="sh-peaks"></div></article><article class="sh-panel"><h3>Collection</h3><div id="sh-collection"></div></article></div>
    <article class="sh-panel sh-hardware"><div class="sh-card-head"><div><h3>Server hardware</h3><p class="sh-muted">Inventory detected on the gateway host</p></div></div><div id="sh-hardware-body"></div></article>`;
  const $ = (selector) => root.querySelector(selector);
  function paint(state) {
    const current = state.current, sample = current?.sample, collection = current?.collection;
    const stale = !!sample && Date.now() - sample.timestamp > Math.max(15_000, (collection?.sampleIntervalMs || 5_000) * 3);
    const errors = Object.entries(state.errors).map(([key, error]) => `${key}: ${error}`);
    if (collection?.error) errors.push(`Collector: ${collection.error}`);
    if (stale) errors.push("The last sample is stale. Displayed values are from the timestamp below.");
    $("#sh-error").hidden = !errors.length;
    $("#sh-error").textContent = errors.join(" · ");
    $("#sh-status").textContent = state.paused ? "Paused" : errors.length ? "Updates interrupted" : sample ? "Live · every 5s" : state.loading ? "Connecting…" : "Awaiting first sample";
    $("#sh-status").classList.toggle("sh-status-warn", state.paused || !!errors.length);
    $("#sh-pause").textContent = state.paused ? "Resume" : "Pause";
    $("#sh-pause").setAttribute("aria-pressed", String(state.paused));
    $("#sh-refresh").disabled = state.loading;
    const severity = storageSeverity(sample?.storagePercent);
    $("#sh-metrics").innerHTML = metric("CPU usage", percent(sample?.cpuPercent), `${sample?.logicalCpus ?? "—"} logical CPUs`, sample?.cpuPercent)
      + metric("Memory", percent(sample?.memoryPercent), `${healthBytes(sample?.memoryUsedBytes)} of ${healthBytes(sample?.memoryTotalBytes)}`, sample?.memoryPercent, "sh-memory")
      + metric("Storage", percent(sample?.storagePercent), `${healthBytes(sample?.storageUsedBytes)} used · ${healthBytes(sample?.storageAvailableBytes)} available`, sample?.storagePercent, `sh-${severity}`, severity === "unknown" ? "" : severity)
      + metric("System load", number(sample?.load1, 2), `${number(sample?.load5, 2)} / ${number(sample?.load15, 2)} at 5 / 15 min`, sample?.logicalCpus ? sample.load1 / sample.logicalCpus * 100 : null);
    const warning = ["warning", "critical"].includes(severity);
    $("#sh-storage-alert").hidden = !warning;
    $("#sh-storage-alert").classList.toggle("sh-critical", severity === "critical");
    $("#sh-storage-alert").textContent = warning ? `Storage ${severity === "critical" ? "critical" : "above 85%"} · ${percent(sample.storagePercent)} used on ${sample.storagePath || "the gateway filesystem"}. ${healthBytes(sample.storageAvailableBytes)} available. Review disk usage and plan capacity.` : "";
    $("#sh-updated").textContent = sample ? `Sample: ${time(sample.timestamp)}${state.paused ? " · paused" : ""}` : "Waiting for the first sample…";
    root.querySelectorAll("[data-range]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.range === state.range)));
    const points = state.range === "live" ? current?.recent || [] : state.history?.points || [];
    const history = state.range === "live" ? {} : state.history || {};
    $("#sh-period").textContent = state.range === "live" ? "Recent live samples · 5-second observations" : `${state.range} period · aggregated observations`;
    $("#sh-resource-chart").innerHTML = healthChart(points, history);
    installTooltip($("#sh-resource-chart"), points, false);
    $("#sh-storage-chart").innerHTML = healthChart(state.storage?.points || [], { ...state.storage, storage: true });
    installTooltip($("#sh-storage-chart"), state.storage?.points, true);
    const forecast = forecastCopy(state.storage?.forecast);
    $("#sh-forecast-title").textContent = forecast.title;
    $("#sh-forecast-detail").textContent = forecast.detail;
    const peaks = state.range === "live" ? Object.fromEntries(["cpuPercent", "memoryPercent", "load1", "storagePercent"].map((field) => { const values = points.map((p) => p[field]).filter(finite); return [field, values.length ? Math.max(...values) : null]; })) : state.history?.peaks;
    $("#sh-peaks").innerHTML = pairs([["CPU", percent(peaks?.cpuPercent)], ["RAM", percent(peaks?.memoryPercent)], ["System load (1 min)", number(peaks?.load1, 2)], ["Storage", percent(peaks?.storagePercent)]]);
    $("#sh-collection").innerHTML = pairs([["Live sampling", collection ? `${number(collection.sampleIntervalMs / 1000, 0)} seconds` : "—"], ["Persisted aggregates", collection ? `${number(collection.aggregateIntervalMs / 1000, 0)} seconds` : "—"], ["Resource retention", collection ? `${collection.resourceRetentionDays} days` : "—"], ["Storage retention", collection ? `${collection.storageRetentionDays} days` : "—"], ["Last persisted", time(collection?.lastPersistedAt)], ["Swap in use", `${healthBytes(sample?.swapUsedBytes)} / ${healthBytes(sample?.swapTotalBytes)}`]]);
    $("#sh-hardware-body").innerHTML = hardwareMarkup(state.hardware);
  }
  const controller = createHealthPoller({ onUpdate: paint });
  $("#sh-pause").addEventListener("click", controller.togglePause);
  $("#sh-refresh").addEventListener("click", controller.refresh);
  root.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => controller.setRange(button.dataset.range)));
  document.addEventListener("visibilitychange", controller.visibilityChanged);
  return controller;
}
