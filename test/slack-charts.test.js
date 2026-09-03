import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { buildChartMessage, postChart } = await import("../src/slack/charts.js");

test("buildChartMessage creates a native line chart and normalizes series order", () => {
  const message = buildChartMessage({
    chartType: "line",
    title: "Weekly requests",
    series: [
      { name: "API", data: [{ label: "Mon", value: 10 }, { label: "Tue", value: 14 }] },
      { name: "Web", data: [{ label: "Tue", value: 9 }, { label: "Mon", value: 7 }] },
    ],
    xLabel: "Day",
    yLabel: "Requests",
  });

  assert.equal(message.blocks[0].type, "data_visualization");
  assert.equal(message.blocks[0].chart.type, "line");
  assert.deepEqual(message.blocks[0].chart.axis_config, {
    categories: ["Mon", "Tue"],
    x_label: "Day",
    y_label: "Requests",
  });
  assert.deepEqual(message.blocks[0].chart.series[1].data, [
    { label: "Mon", value: 7 },
    { label: "Tue", value: 9 },
  ]);
  assert.match(message.text, /Weekly requests.*API.*Mon 10.*Web.*Tue 9/);
});

test("buildChartMessage creates a native pie chart with supplied accessible text", () => {
  const message = buildChartMessage({
    chartType: "pie",
    title: "Tickets by status",
    segments: [{ label: "Open", value: 8 }, { label: "Closed", value: 12 }],
    summary: "Eight tickets are open and twelve are closed.",
  });

  assert.equal(message.text, "Eight tickets are open and twelve are closed.");
  assert.deepEqual(message.blocks[0].chart, {
    type: "pie",
    segments: [{ label: "Open", value: 8 }, { label: "Closed", value: 12 }],
  });
});

test("chart validation enforces Slack's data-shape limits", () => {
  assert.throws(
    () => buildChartMessage({
      chartType: "bar",
      title: "Mismatch",
      series: [
        { name: "A", data: [{ label: "Mon", value: 1 }, { label: "Tue", value: 2 }] },
        { name: "B", data: [{ label: "Mon", value: 3 }] },
      ],
    }),
    /Every series must contain exactly one data point/,
  );
  assert.throws(
    () => buildChartMessage({ chartType: "pie", title: "Bad", segments: [{ label: "Nope", value: 0 }] }),
    /greater than zero/,
  );
  assert.throws(
    () => buildChartMessage({ chartType: "pie", title: "Bad", segments: [{ label: "A", value: 1 }, { label: "A", value: 2 }] }),
    /labels must be unique/,
  );
  assert.throws(
    () => buildChartMessage({ chartType: "line", title: "x".repeat(51), series: [{ name: "A", data: [{ label: "Mon", value: 1 }] }] }),
    /50 characters or fewer/,
  );
});

test("postChart posts only to the trusted channel and thread with bot auth", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, channel: "C123", ts: "123.456" }) };
  };

  const result = await postChart({
    channelId: "C123",
    threadTs: "111.222",
    chartType: "bar",
    title: "Builds",
    series: [{ name: "Passed", data: [{ label: "Mon", value: 4 }] }],
  }, { token: "xoxb-test", fetchImpl });

  assert.deepEqual(result, { channel: "C123", ts: "123.456" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].options.headers.Authorization, "Bearer xoxb-test");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.channel, "C123");
  assert.equal(body.thread_ts, "111.222");
  assert.equal(body.blocks[0].type, "data_visualization");
});

test("postChart reports missing context and Slack API errors", async () => {
  await assert.rejects(() => postChart({ chartType: "pie", title: "No channel" }, { token: "xoxb-test" }), /No channel context/);
  await assert.rejects(
    () => postChart({
      channelId: "C123",
      chartType: "pie",
      title: "Tickets",
      segments: [{ label: "Open", value: 1 }],
    }, {
      token: "xoxb-test",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_blocks" }) }),
    }),
    /invalid_blocks/,
  );
});

test("gateway-usage skill description and capability map trigger native chart guidance", () => {
  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  const charts = readFileSync(new URL("../src/gateway/gateway-usage/references/charts.md", import.meta.url), "utf8");

  assert.match(skill, /description:[\s\S]*chart, graph, data visualization, trend, comparison/i);
  assert.match(skill, /trend \/ comparison \/ composition as a chart[\s\S]*slack_post_chart/i);
  assert.match(charts, /native Slack Block Kit chart/);
  assert.match(charts, /line[\s\S]*area[\s\S]*bar[\s\S]*pie/);
});
