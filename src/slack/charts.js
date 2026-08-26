// Post native Slack Block Kit data-visualization charts with the workspace BOT token.
// The caller supplies the channel/thread from trusted gateway context; neither is exposed as an
// AI-controlled tool argument. Native charts need only the bot's existing `chat:write` scope.
import { resolveSlackConfig } from "../config/settings.js";

const API = "https://slack.com/api";
const CHART_TYPES = new Set(["line", "bar", "area", "pie"]);

function requiredText(value, field, max) {
  const out = String(value ?? "").trim();
  if (!out) throw new Error(`\`${field}\` is required.`);
  if (out.length > max) throw new Error(`\`${field}\` must be ${max} characters or fewer.`);
  return out;
}

function optionalText(value, field, max) {
  const out = String(value ?? "").trim();
  if (out.length > max) throw new Error(`\`${field}\` must be ${max} characters or fewer.`);
  return out;
}

function finiteNumber(value, field, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`\`${field}\` must be a finite number.`);
  if (positive && value <= 0) throw new Error(`\`${field}\` must be greater than zero.`);
  return value;
}

function boundedArray(value, field, max) {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`\`${field}\` must contain at least one item.`);
  if (value.length > max) throw new Error(`\`${field}\` supports at most ${max} items.`);
  return value;
}

function clippedFallback(value) {
  const text = String(value || "").trim();
  return text.length <= 3000 ? text : `${text.slice(0, 2999)}…`;
}

function pieChart(segments) {
  const normalized = boundedArray(segments, "segments", 12).map((segment, index) => ({
    label: requiredText(segment?.label, `segments[${index}].label`, 20),
    value: finiteNumber(segment?.value, `segments[${index}].value`, { positive: true }),
  }));
  const labels = normalized.map(({ label }) => label);
  if (new Set(labels).size !== labels.length) throw new Error("Pie segment labels must be unique.");
  return { type: "pie", segments: normalized };
}

function seriesChart(type, series, xLabel, yLabel) {
  const normalizedSeries = boundedArray(series, "series", 12).map((item, seriesIndex) => ({
    name: requiredText(item?.name, `series[${seriesIndex}].name`, 20),
    data: boundedArray(item?.data, `series[${seriesIndex}].data`, 20).map((point, pointIndex) => ({
      label: requiredText(point?.label, `series[${seriesIndex}].data[${pointIndex}].label`, 20),
      value: finiteNumber(point?.value, `series[${seriesIndex}].data[${pointIndex}].value`),
    })),
  }));

  const names = normalizedSeries.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new Error("Series names must be unique.");

  const categories = normalizedSeries[0].data.map(({ label }) => label);
  if (new Set(categories).size !== categories.length) throw new Error("Data-point labels must be unique within a series.");

  // Slack requires every series to contain exactly one point for every category. Accept any input
  // order, validate the set, then normalize to the first series' category order.
  for (const [seriesIndex, item] of normalizedSeries.entries()) {
    const byLabel = new Map(item.data.map((point) => [point.label, point]));
    if (byLabel.size !== item.data.length) throw new Error(`Data-point labels in series ${seriesIndex + 1} must be unique.`);
    if (item.data.length !== categories.length || categories.some((label) => !byLabel.has(label))) {
      throw new Error("Every series must contain exactly one data point for every label in the first series.");
    }
    item.data = categories.map((label) => byLabel.get(label));
  }

  const axisConfig = { categories };
  const x = optionalText(xLabel, "x_label", 50);
  const y = optionalText(yLabel, "y_label", 50);
  if (x) axisConfig.x_label = x;
  if (y) axisConfig.y_label = y;
  return { type, series: normalizedSeries, axis_config: axisConfig };
}

export function buildChartMessage({ chartType, title, series, segments, xLabel, yLabel, summary } = {}) {
  const type = String(chartType || "").trim().toLowerCase();
  if (!CHART_TYPES.has(type)) throw new Error("`chart_type` must be one of: line, bar, area, pie.");
  const cleanTitle = requiredText(title, "title", 50);
  const chart = type === "pie" ? pieChart(segments) : seriesChart(type, series, xLabel, yLabel);
  const block = { type: "data_visualization", title: cleanTitle, chart };

  const suppliedSummary = optionalText(summary, "summary", 3000);
  const generatedSummary = type === "pie"
    ? `${cleanTitle}: ${chart.segments.map(({ label, value }) => `${label} ${value}`).join(", ")}.`
    : `${cleanTitle}: ${chart.series.map(({ name, data }) => `${name} — ${data.map(({ label, value }) => `${label} ${value}`).join(", ")}`).join("; ")}.`;

  return { text: suppliedSummary || clippedFallback(generatedSummary), blocks: [block] };
}

export async function postChart(
  { channelId, threadTs = "", chartType, title, series, segments, xLabel, yLabel, summary } = {},
  { token = resolveSlackConfig().botToken || "", fetchImpl = fetch } = {},
) {
  if (!channelId) throw new Error("No channel context — can't post a chart here.");
  if (!token) throw new Error("Slack bot token isn't configured (set it in the admin Settings).");
  const message = buildChartMessage({ chartType, title, series, segments, xLabel, yLabel, summary });
  const body = { channel: channelId, ...message };
  if (threadTs) body.thread_ts = threadTs;

  const response = await fetchImpl(`${API}/chat.postMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Slack chat.postMessage failed (HTTP ${response.status}).`);
  if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error || "unknown error"}`);
  return { ts: data.ts || "", channel: data.channel || channelId };
}
