import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

test("time buckets render separate stacked columns with model segments", () => {
  const chart = runInNewContext(`${between("function stackValue(", "// Legend for a stacked chart")}; stackedColumns`, {});
  const keys = [
    { key: "a", color: "#111111" },
    { key: "b", color: "#222222" },
  ];
  const series = [
    { models: { a: { cost: 3 }, b: { cost: 2 } } },
    { models: { a: { cost: 1 }, b: { cost: 4 } } },
  ];
  const svg = chart(series, keys, "cost", { height: 110 });
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="([^"]+)"\/>/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]), color: match[5] }));
  assert.equal(rects.length, 4);
  assert.deepEqual([...new Set(rects.map((r) => r.x))], [1, 151]);
  assert.ok(rects.every((r) => r.width < 150 && r.height > 0));
  for (const x of [1, 151]) {
    const column = rects.filter((r) => r.x === x);
    assert.deepEqual(column.map((r) => r.color), ["#111111", "#222222"]);
    assert.ok(Math.abs(column.reduce((sum, r) => sum + r.height, 0) - 102) < 0.02);
  }
});

test("model bars expose the total and breakdown on hover and keyboard focus", () => {
  const render = runInNewContext(`${between("function stackValue(", "// Legend for a stacked chart")}
    ${between("function barTrack(", "// Single-metric horizontal bar list")}; barTrack`, {
    fmtUSD: (n) => `$${n.toFixed(2)}`,
    fmtCompact: String,
    fmtNum: String,
    escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
    MODEL_OTHER: "#888888",
  });
  const html = render(80, {
    stack: {
      row: { name: "Test channel", models: { a: { runs: 3 }, b: { runs: 2 } } },
      keys: [{ key: "a", label: "Model A", color: "#111111" }, { key: "b", label: "Model B", color: "#222222" }],
      metric: "runs",
    },
  });
  assert.match(html, /tabindex="0"/);
  assert.match(html, /Test channel, Runs: 5\. Model A: 3, Model B: 2/);
  assert.match(html, /class="spark-tip bar-tip"/);
  assert.match(html, /Model A<b>3<\/b>/);
  assert.match(html, /Model B<b>2<\/b>/);
  assert.match(css, /\.bar-hover:hover \.bar-tip, \.bar-hover:focus \.bar-tip \{ display: block; \}/);
});

test("Overview orders four compact cards above Models, Channels, Users and Skills", () => {
  assert.match(app, /<div class="dash-grid">\$\{charts\}\$\{originsCard\}<\/div>/);
  const stack = between('<div class="dash-stack">', "// Approvals waiting on a human");
  const order = ["${modelsCard}", "Channels —", "Runs per user", "Top skills —"].map((label) => stack.indexOf(label));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(css, /\.dash-grid \{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.dash-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});
