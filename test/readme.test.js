// Guards for the public README: product identity, licensing, navigation, support status,
// lead-generation links and badge/file links. Keep editorial expectations aligned with the
// homepage; test/license.test.js owns the underlying licensing terms.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readReadme = () => readFile(path.join(repoRoot, "README.md"), "utf8");

// The repository URL is a constant so a rename at launch is one `sed`. Every occurrence in every
// public file has to be byte-identical for that to be true.
const REPO_URL = "https://github.com/makeitfutureDev/channelgate";
const TAGLINE =
  "Run Claude Code and OpenAI Codex in team chat, with a container per conversation and control " +
  "over tools, credentials and memory.";
const UTM = "utm_source=github&utm_medium=readme&utm_campaign=channelgate";
// The pre-rename display name, allowed exactly once in the README (test/channelgate-rename.test.js
// caps how many files may still carry it at all — this one is on that allowlist).
const FORMER_ATTRIBUTION = "formerly Claude Gateway for Slack";

/** Markdown minus fenced code blocks and HTML comments — the parts a reader never sees as prose. */
const prose = (md) => md.replace(/```[\s\S]*?```/g, "").replace(/<!--[\s\S]*?-->/g, "");

const countOf = (text, pattern) => (text.match(pattern) || []).length;

test("the hero opens with one descriptive H1, the product name, and its value proposition", async () => {
  const readme = await readReadme();
  const headings = prose(readme)
    .split("\n")
    .filter((line) => /^#\s+\S/.test(line));
  assert.deepEqual(headings, ["# ChannelGate — Self-hosted AI agents for Slack, Teams and Google Chat"],
    "the README must have one descriptive H1 naming the product and its chat platforms");

  assert.ok(readme.includes(TAGLINE), "the hero tagline is missing or was reworded");
  const taglineLine = readme.split("\n").find((line) => line.includes(TAGLINE));
  assert.match(taglineLine, /^\*\*.*\.\*\*$/, "the tagline must be its own bolded line");
});

test("the former product name appears exactly once, as the 'formerly' attribution", async () => {
  const readme = await readReadme();
  assert.equal(
    countOf(readme, new RegExp(FORMER_ATTRIBUTION, "gi")),
    1,
    `say "${FORMER_ATTRIBUTION}" exactly once — no more, and never zero`,
  );
});

test("the README never calls the project open source", async () => {
  const readme = await readReadme();
  // The ONE allowed form is the licensing disclaimer, which the license test also asserts.
  assert.match(readme, /not OSI open-source/);
  const withoutDisclaimer = readme.replace(/not OSI open-source/g, "«disclaimer»");
  const stray = withoutDisclaimer.match(/open[\s-]source/gi) || [];
  assert.deepEqual(
    stray,
    [],
    "this is source-available fair-code; 'open source' must not appear outside 'not OSI open-source'",
  );
});

test("the single Makeitfuture CTA carries the mailto and both UTM-tagged links", async () => {
  const readme = await readReadme();
  assert.ok(
    readme.includes("mailto:contact@makeitfuture.com?subject=ChannelGate%20discovery%20call"),
    "the discovery-call mailto (URL-encoded subject) is missing",
  );
  assert.ok(
    readme.includes(`https://channelgate.dev/?${UTM}`),
    "the product-page link must carry the README UTM triple",
  );
  assert.ok(
    readme.includes(`https://channelgate.dev/partners?${UTM}`),
    "the partner link must be /partners on the same base, with the same UTM triple",
  );
  // Attribution is only useful if it is unambiguous: one campaign, one CTA block.
  assert.equal(countOf(readme, /utm_campaign=channelgate/g), 2);
  assert.equal(countOf(readme, /https:\/\/channelgate\.dev\/(?!partners)/g), 1);
});

test("every relative link in the README resolves to a file that exists", async () => {
  const readme = await readReadme();
  const broken = [];
  const links = prose(readme).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g);
  for (const [, target] of links) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const [relative] = target.split("#"); // anchors are not resolved, only the path
    if (!relative) continue;
    if (!existsSync(path.join(repoRoot, relative))) broken.push(target);
  }
  assert.deepEqual(broken, [], `README links point at files that do not exist: ${broken.join(", ")}`);
});

test("badge URLs are well-formed and the CI badge names a workflow that exists", async () => {
  const readme = await readReadme();
  const images = [...prose(readme).matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
  assert.ok(images.length >= 5, "the hero needs its five badges");

  for (const [, alt, url] of images) {
    assert.match(url, /^https:\/\//, `badge "${alt}" must be an absolute https URL`);
    assert.doesNotMatch(url, /\s/, `badge "${alt}" contains whitespace`);
    // A half-encoded label is the classic shields.io breakage: it renders as a 404 image.
    for (const escape of url.match(/%.{0,2}/g) || []) {
      assert.match(escape, /^%[0-9A-Fa-f]{2}$/, `badge "${alt}" has a broken percent-escape: ${escape}`);
    }
    if (url.startsWith("https://img.shields.io/")) {
      assert.match(
        url,
        /^https:\/\/img\.shields\.io\/badge\/[^\s-]+-[^\s]+-[0-9a-fA-F]{6}$/,
        `badge "${alt}" is not a valid static shields.io badge (label-message-hexcolour)`,
      );
    }
  }

  const shields = images.map(([, , url]) => url).filter((url) => url.includes("img.shields.io"));
  assert.ok(
    shields.some((url) => url.includes("/badge/license-Sustainable%20Use%20License%201.4-")),
    "the license badge must name Sustainable Use License 1.4, URL-encoded",
  );
  assert.ok(shields.some((url) => url.includes("/badge/node-%E2%89%A5%2022.13-")), "Node floor badge");
  assert.ok(shields.some((url) => /\/badge\/platforms-Slack.*Teams.*Google%20Chat-/.test(url)), "platforms badge");
  assert.ok(shields.some((url) => /\/badge\/engines-Claude%20Code.*Codex.*OpenCode-/.test(url)), "engines badge");

  const ci = images.find(([, , url]) => url.includes("/actions/workflows/"));
  assert.ok(ci, "the CI badge is missing");
  assert.equal(ci[2], `${REPO_URL}/actions/workflows/ci.yml/badge.svg`);
  assert.ok(existsSync(path.join(repoRoot, ".github/workflows/ci.yml")), "the badge names a workflow that must exist");
});

test("every GitHub URL uses the one repository constant, so a launch rename is one sed", async () => {
  const readme = await readReadme();
  const wrong = (readme.match(/https:\/\/github\.com\/[^\s)"'`]+/g) || []).filter(
    (url) => !url.startsWith(REPO_URL),
  );
  assert.deepEqual(wrong, [], `these GitHub URLs do not use the repository constant: ${wrong.join(", ")}`);
});

test("the licensing section keeps the tier limit and the no-automatic-relicensing promise", async () => {
  const readme = await readReadme();
  const section = readme.slice(
    readme.indexOf("## Licensing & partners"),
    readme.indexOf("## Want it installed and operated for you?"),
  );
  assert.ok(section.length > 500, "the Licensing & partners section is missing or truncated");
  assert.match(section, /source-available fair-code/i);
  assert.match(section, /not OSI open-source/);
  assert.match(section, /500 AI messages per conversation per month/);
  assert.match(section, /no version\s+is relicensed automatically/);
  assert.match(section, /\| \*\*No key\*\* — install and run \| 1 \| 500 \|/);
  // The three lanes the release plan sells against.
  for (const lane of [/\*\*Free — /, /\*\*Partner — /, /\*\*Reseller, white-label, enterprise — /]) {
    assert.match(section, lane);
  }
  for (const doc of ["./LICENSE.md", "./docs/LICENSE-KEYS.md", "./docs/LICENSING-FAQ.md", "./TRADEMARK.md", "./CLA.md"]) {
    assert.ok(section.includes(`(${doc})`), `the licensing section must link ${doc}`);
  }
});

test("the homepage presents benefits, setup, features, support and licensing in a readable order", async () => {
  const readme = await readReadme();
  const order = [
    "# ChannelGate — Self-hosted AI agents for Slack, Teams and Google Chat",
    "## What you get",
    "## Getting started",
    "## Full feature list",
    "## Use cases",
    "## Supported platforms and AI engines",
    "## How it works",
    "## Security and data privacy",
    "## Deployment tradeoffs",
    "## Licensing & partners",
    "## Want it installed and operated for you?",
    "## Documentation",
    "## Configuration and local storage",
  ];
  const positions = order.map((heading) => {
    const at = readme.indexOf(`${heading}\n`);
    assert.notEqual(at, -1, `missing section: ${heading}`);
    return at;
  });
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "hero sections are out of order",
  );
});

test("public entrypoints describe support and do not link absent promotional assets", async () => {
  const readme = await readReadme();
  assert.doesNotMatch(readme, /docs\/assets\/(demo|social-preview)/);
  assert.match(readme, /Microsoft Teams and Google Chat are\s+Beta/);
  assert.match(readme, /Composio SDK mode is Enterprise-only and Beta/);
  const maintainer = await readFile(path.join(repoRoot, "docs/MAINTAINER-RELEASE.md"), "utf8");
  assert.match(maintainer, /gh attestation verify/);
  assert.match(maintainer, /unsigned build metadata/);
});
