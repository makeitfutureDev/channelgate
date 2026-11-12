// Shared compact subscription presentation. Self-contained so Activity can embed it under its nonce.
export function createSubscriptionUi() {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const stamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not yet checked";
  const duration = (minutes) => minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  function reset(value, now = Date.now()) {
    if (!value || !Number.isFinite(Date.parse(value))) return "Reset time unavailable";
    const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
    return minutes <= 0 ? "Reset time passed · awaiting provider update" : `Resets in ${duration(minutes)} · ${stamp(value)}`;
  }
  const valid = (window) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100;
  const windows = (row) => (Array.isArray(row.windows) ? row.windows : []).filter((window) => window && valid(window));
  const percent = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const severity = (value) => value >= 90 ? "critical" : value >= 75 ? "warning" : "normal";
  // Older payloads predate kind; connected quota windows are still unambiguous subscription data.
  const isSubscription = (row) => row.kind === "subscription" || (!row.kind && (row.status === "ok" || windows(row).length > 0));
  function meter(window) {
    return `<progress max="100" value="${window.usedPercent}" aria-label="${esc(window.label)} usage">${percent(window.usedPercent)}%</progress><strong>${percent(window.usedPercent)}%</strong>`;
  }
  // One compact meter per subscription: a short line on wide screens, a ring when narrow. The
  // ring is SVG attributes (no inline style) so it renders under the page's nonce-only CSP.
  function summary(rows) {
    return rows.filter(isSubscription).map((row) => {
      const strongest = windows(row).sort((a, b) => b.usedPercent - a.usedPercent)[0];
      const detail = `${row.stale ? "Stale · " : ""}${strongest ? `${strongest.label} ${percent(strongest.usedPercent)}% · ${reset(strongest.resetsAt)}` : "Usage unavailable"}`;
      const ring = `<svg class="subscription-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="ring-track" cx="10" cy="10" r="7.5" pathLength="100"/>${strongest ? `<circle class="ring-value" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${Math.max(0, Math.min(100, strongest.usedPercent))} 100"/>` : ""}</svg>`;
      return `<div class="subscription-quick ${strongest ? severity(strongest.usedPercent) : "unavailable"}${row.stale ? " stale" : ""}" title="${esc(row.name)} · ${esc(detail)}"><span class="subscription-quick-name">${esc(row.name)}</span>${strongest ? `<progress max="100" value="${strongest.usedPercent}" aria-label="${esc(row.name)} ${esc(strongest.label)} usage">${percent(strongest.usedPercent)}%</progress>` : ""}${ring}<strong>${strongest ? `${percent(strongest.usedPercent)}%` : "—"}</strong></div>`;
    }).join("");
  }
  function expiry(value) {
    const minutes = Math.ceil((Date.parse(value) - Date.now()) / 60_000);
    return minutes > 0 ? `in ${duration(minutes)} · ${stamp(value)}` : `${stamp(value)} · expired`;
  }
  function card(row) {
    const labels = { ok: "Connected", expired: "Login expired", "not-connected": "Not connected", "api-key": "API billing", unavailable: "Usage unavailable", unsupported: "Not supported" };
    const status = Object.hasOwn(labels, row.status) ? row.status : "unavailable";
    const email = typeof row.account?.email === "string" ? row.account.email : "";
    const workspace = typeof row.account?.workspace === "string" ? row.account.workspace : "";
    const account = isSubscription(row) ? `<div class="subscription-account"><span>${email ? esc(email) : "Account unavailable"}</span>${workspace ? `<span class="subscription-workspace">${esc(workspace)}</span>` : ""}</div>` : "";
    const limits = windows(row).map((window) => `<div class="subscription-window ${severity(window.usedPercent)}"><div class="subscription-window-head"><span>${esc(window.label)}</span>${meter(window)}</div><div class="subscription-window-foot">${esc(reset(window.resetsAt))}</div></div>`).join("");
    const credits = row.resetCredits;
    const creditRows = (Array.isArray(credits?.resets) ? credits.resets : []).filter((item) => item && typeof item === "object");
    const banked = creditRows.some((item) => item.paused === true || item.usableNow === false);
    const resetRows = creditRows.map((item) => {
      const count = Number.isSafeInteger(item.remaining) && item.remaining > 1 ? ` (${item.remaining} remaining)` : "";
      const state = item.paused === true ? " (paused)" : item.usableNow === false ? " (when limit reached)" : "";
      const expires = item.expiresAt && Number.isFinite(Date.parse(item.expiresAt)) ? `expires ${esc(expiry(item.expiresAt))}` : "· expiry unavailable";
      return `<p>${esc(item.label || "Reset credit")}${count}${state} ${expires}</p>`;
    }).join("");
    const resets = credits && Number.isSafeInteger(credits.available) && credits.available >= 0
      ? `<div class="subscription-resets"><div><span>Usage limit resets</span><strong>${credits.available} ${banked ? "remaining" : "available"}</strong></div>${resetRows}${credits.available > 0 && creditRows.length === 0 ? "<p>Reset expiry unavailable</p>" : ""}</div>` : "";
    const subscriptionExpiry = row.expiresAt && Number.isFinite(Date.parse(row.expiresAt)) ? `<p class="subscription-expiry">Subscription expires ${esc(expiry(row.expiresAt))}</p>` : "";
    return `<article class="subscription-card${row.stale ? " stale" : ""}"><div class="subscription-card-head"><h3>${esc(row.name)}</h3><span class="subscription-plan">${esc(row.plan || labels[status])}</span></div>${account}${row.stale || status !== "ok" ? `<p class="subscription-status ${status}">${row.stale ? "Stale data · " : ""}${labels[status]}</p>` : ""}${row.message ? `<p class="subscription-message">${esc(row.message)}</p>` : ""}${limits || '<p class="subscription-message">No subscription usage data available.</p>'}${resets}${subscriptionExpiry}<p class="subscription-updated">Updated ${esc(stamp(row.updatedAt))}${row.stale ? ` · Last check ${esc(stamp(row.checkedAt))}` : ""}</p></article>`;
  }
  return { card, summary, reset, isSubscription };
}

export const SUBSCRIPTION_CSS = `
.subscription-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:14px;margin:20px 0;align-items:start}
.subscription-card{min-width:0;padding:16px 18px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.subscription-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.subscription-card h3{font-size:18px;line-height:1.4;margin:0;font-weight:600}
.subscription-account{display:flex;flex-direction:column;gap:2px;margin:-5px 0 12px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}.subscription-workspace{font-size:13px;opacity:1}
.subscription-plan{color:var(--muted);font-size:13px;border:1px solid var(--line);border-radius:20px;padding:2px 8px;max-width:60%;overflow-wrap:anywhere;text-transform:capitalize}
.subscription-status,.subscription-message{color:var(--muted);font-size:14px;margin:8px 0}.subscription-status.expired{color:var(--danger)}
.subscription-window{margin-top:12px}.subscription-window-head{display:grid;grid-template-columns:minmax(80px,1fr) minmax(55px,1fr) auto;align-items:center;gap:10px;font-size:15px;color:var(--muted)}
.subscription-window-head strong,.subscription-quick strong{font-size:22px;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600;white-space:nowrap}.subscription-window-foot{font-size:13px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.subscription-grid progress,.subscription-quick progress{display:block;width:100%;height:9px;margin:0;border:0;border-radius:10px;overflow:hidden;background:var(--panel-2);accent-color:var(--muted)}
.subscription-grid progress::-webkit-progress-bar,.subscription-quick progress::-webkit-progress-bar{background:var(--panel-2);border-radius:10px}.subscription-grid progress::-webkit-progress-value,.subscription-quick progress::-webkit-progress-value{background:var(--muted);border-radius:10px}.subscription-grid progress::-moz-progress-bar,.subscription-quick progress::-moz-progress-bar{background:var(--muted);border-radius:10px}
.subscription-grid .warning progress,.subscription-quick.warning progress{accent-color:var(--warn)}.subscription-grid .warning progress::-webkit-progress-value,.subscription-quick.warning progress::-webkit-progress-value{background:var(--warn)}.subscription-grid .warning progress::-moz-progress-bar,.subscription-quick.warning progress::-moz-progress-bar{background:var(--warn)}
.subscription-grid .critical progress,.subscription-quick.critical progress{accent-color:var(--danger)}.subscription-grid .critical progress::-webkit-progress-value,.subscription-quick.critical progress::-webkit-progress-value{background:var(--danger)}.subscription-grid .critical progress::-moz-progress-bar,.subscription-quick.critical progress::-moz-progress-bar{background:var(--danger)}
.subscription-updated{color:var(--muted);font-size:13px;margin:12px 0 0;opacity:1}.subscription-resets{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:14px;color:var(--muted)}.subscription-resets>div{display:flex;justify-content:space-between;gap:10px}.subscription-resets p,.subscription-expiry{font-size:13px;color:var(--muted);margin:5px 0 0}
.subscription-quick-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;margin:20px 0}.subscription-quick{display:grid;grid-template-columns:minmax(70px,1fr) minmax(50px,1fr) auto;align-items:center;gap:4px 10px;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.subscription-quick-name{font-size:15px;overflow-wrap:anywhere}.subscription-quick small{grid-column:1/-1;color:var(--muted);font-size:13px}.subscription-unavailable{grid-column:2/-1;font-size:14px;color:var(--muted)}.subscription-quick.stale{border-style:dashed}
#subscriptions-notice{color:var(--muted);font-size:15px;margin:12px 0}.subscriptions-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:24px 0 10px}.subscriptions-head h1{font-size:24px}.subscriptions-head h1::after{display:none}.subscriptions-copy{color:var(--muted);font-size:15px;margin:0}
@media(max-width:420px){.subscription-card{padding:14px}.subscription-window-head{gap:8px}}
`;
