import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const here = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("a running Slack turn survives active dashboard publication, verification rollback and a successful retry", {
  skip: !process.env.CG_BROWSER_MODULE, timeout: 90_000,
}, async t => {
  // Modules resolve their assets against import.meta.url. Give this serving instance a real
  // private checkout: other test workers can continue to read their own UI throughout.
  const repo = tempDir("cg-live-ui-repo-");
  for (const file of ["src", "public", "scripts", "containers", "package.json", "tsconfig.json", "test/runtime-fake.js"]) {
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(here, file), target, { recursive: true });
  }
  symlinkSync(path.dirname(path.dirname(require.resolve("typescript/package.json"))), path.join(repo, "node_modules"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "deployment");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Fixture");
  git("add", "public"); git("commit", "-qm", "Initial dashboard");
  const previous = git("rev-parse", "HEAD");
  git("switch", "-qc", "candidate");
  const replace = (file: string, old: string, next: string) => {
    const name = path.join(repo, file), original = readFileSync(name, "utf8");
    assert.ok(original.includes(old)); writeFileSync(name, original.replace(old, next));
  };
  replace("public/index.html", "<head>", '<head data-hot-ui="B">');
  replace("public/activity/call-history.html", "<h1>Calls</h1>", "<h1>Calls release B</h1>");
  appendFileSync(path.join(repo, "public/activity/call-history.ts"), '\ndocument.documentElement.dataset.hotUi = "B";');
  appendFileSync(path.join(repo, "public/styles.css"), "\n/* dashboard CSS release B */");
  git("commit", "-qam", "Second dashboard"); const candidate = git("rev-parse", "HEAD");
  git("switch", "-q", "deployment");

  const load = (name: string) => import(pathToFileURL(path.join(repo, name)).href);
  const { createWebApp } = await load("src/web/app.js");
  const { createActivityGrantUrl } = await load("src/web/activity.js");
  const { saveSettings } = await load("src/config/settings.js");
  const { hashPassword } = await load("src/web/security.js");
  const { setUser } = await load("src/config/store.js");
  const { processMessageEvent } = await load("src/slack/message-pipeline.js");
  const { getDb } = await load("src/db/index.js");
  const { useFakeRuntime, createFakeRuntimeBackend } = await load("test/runtime-fake.js");
  const { executeUpdateTransaction, healthAt } = await load("scripts/update-runner.mjs");
  const { reserveUpdate, claimUpdate } = await load("src/gateway/update-state.js");
  const { prepareDashboardUpdate, moveDashboardCheckout, withDashboardCheckout } = await load("src/gateway/dashboard-update.ts");
  const root = process.env.CHANNELGATE_DIR!, secret = randomUUID(), password = randomUUID();
  process.env.CG_APPROVAL_SECRET = secret;
  process.env.SESSION_KEEPALIVE = "0";
  const user = "U_DASHBOARD", channel = "D_DASHBOARD", thread = "123.456";
  await setUser(user, { approved: true });
  await saveSettings({ adminPassword: await hashPassword(password), engine: "claude", engineFallback: false, memoryReviewEvery: 0 });
  const ok = async () => ({ ok: true });
  const messages: string[] = [], reactions: string[] = [];
  let streamSequence = 0;
  const slackClient = {
    chat: { postMessage: async ({ text }: { text: string }) => { messages.push(text); return { ok: true, ts: "999.1" }; }, update: ok, delete: ok },
    apiCall: ok,
    chatStream: () => {
      let text = "";
      return {
        ts: "999." + ++streamSequence,
        append: async (args: { markdown_text?: string }) => { text += args.markdown_text ?? ""; },
        stop: async (args?: { markdown_text?: string }) => { messages.push(text + (args?.markdown_text ?? "")); },
      };
    },
    reactions: { add: async () => { reactions.push("add"); return ok(); }, remove: async () => { reactions.push("remove"); return ok(); } },
    conversations: { info: async () => ({ channel: { id: channel } }), history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { id: user } }), list: async () => ({ members: [] }) },
  };
  const slack = { getClient: () => slackClient, snapshot: () => ({ connected: true, status: "connected", teamId: "T_UI" }) };
  const app = createWebApp({ slack, containerRuntimeStatus: async () => ({ cli: { ok: true } }) });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  await saveSettings({ publicUrl: base });
  const health = () => healthAt({ port, secret });
  const baseline = await health();
  assert.equal(baseline.revision, previous);
  const { chromium } = await import(process.env.CG_BROWSER_MODULE!);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const grant = createActivityGrantUrl({ baseUrl: base, ownerId: user, teamId: "T_UI" });
  const exchange = await context.request.post(base + "/activity/exchange", { headers: { Origin: base }, data: { token: new URL(grant).hash.slice(1) } });
  assert.equal(exchange.status(), 200);
  const callsUrl = base + (await exchange.json()).url + "/calls";
  assert.equal((await context.request.post(base + "/api/login", { data: { password } })).status(), 200);
  const oldCalls = await context.newPage(); await oldCalls.goto(callsUrl);
  await oldCalls.getByRole("status").filter({ hasText: "No calls recorded yet" }).waitFor();
  const cssUrl = '/styles.css?v=' + baseline.adminView.revision;
  const scriptUrl = await oldCalls.locator('script[src^="/activity/assets/calls/"]').getAttribute("src");
  const bytes = async (url: string) => {
    const response = await context.request.get(base + url);
    assert.equal(response.status(), 200);
    return response.text();
  };
  const cssA = await bytes(cssUrl), jsA = await bytes(scriptUrl);
  const admin = await context.newPage(), calls = await context.newPage();
  const verifyViews = async (version: "A" | "B") => {
    await admin.goto(base, { waitUntil: "domcontentloaded" });
    assert.equal(await admin.locator("head").getAttribute("data-hot-ui"), version === "A" ? null : "B");
    const css = await bytes(await admin.locator('link[href^="/styles.css"]').getAttribute("href"));
    assert.equal(css.includes("dashboard CSS release B"), version === "B");
    await calls.goto(callsUrl);
    await calls.getByRole("heading", { name: version === "A" ? "Calls" : "Calls release B", exact: true }).waitFor();
    assert.equal(await calls.locator("html").getAttribute("data-hot-ui"), version === "A" ? null : "B");
    assert.equal(await bytes(cssUrl), cssA);
    assert.equal(await bytes(scriptUrl), jsA);
    await oldCalls.getByRole("button", { name: "Refresh", exact: true }).click();
    await oldCalls.getByRole("status").filter({ hasText: "No calls recorded yet" }).waitFor();
  };

  // Real foreground pipeline and child process, with a local stand-in for the model.
  const ready = path.join(repo, "child-ready"), go = path.join(repo, "child-can-finish");
  const answer = "UI update survivor replied once.";
  const program = `const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid));
    const timer = setInterval(() => { if (!fs.existsSync(process.argv[2])) return;
      clearInterval(timer); console.log(JSON.stringify({type:"result",subtype:"success",result:process.argv[3],session_id:"test-session",usage:{input_tokens:1,output_tokens:1}})); }, 20);`;
  const backend = createFakeRuntimeBackend(), spawn = backend.spawn;
  backend.spawn = (target: unknown, spec: object) => spawn(target, { ...spec, cmd: process.execPath, args: ["-e", program, ready, go, answer] });
  await useFakeRuntime(backend);
  const run = processMessageEvent({ type: "message", channel, channel_type: "im", user, text: "Complete the controlled turn", ts: thread }, slackClient, { botUserId: "U_BOT", teamId: "T_UI" });
  try {
    for (let i = 0; !existsSync(ready) && i < 500; i++) await delay(20);
    assert.ok(existsSync(ready), "fixture engine never started");
    const pid = Number(readFileSync(ready, "utf8"));
    const assertRunning = () => {
      process.kill(pid, 0);
      assert.equal(backend.calls.spawn.length, 1);
      assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM active_runs").get().n, 1);
      assert.deepEqual(reactions, ["add"]);
      assert.ok(!messages.some(text => text.includes(answer)));
    };
    const transaction = async (rejectPublication: boolean) => {
      let inspected = false;
      const baselineHealth = await health();
      assert.equal(baselineHealth.instanceId, baseline.instanceId);
      const uiRelease = prepareDashboardUpdate(repo, previous, candidate, baselineHealth);
      assert.ok(uiRelease?.candidate.revisions.adminView && uiRelease.candidate.revisions.callsView);
      const { owner } = reserveUpdate({ root, source: "browser acceptance" });
      return executeUpdateTransaction({ root, repoRoot: repo, owner, ops: {
        claim: () => assert.ok(claimUpdate({ root, owner, pid: process.pid })),
        preflight: async () => ({ oldRevision: previous, targetRevision: candidate, baselineHealth, uiRelease }),
        checkoutUi: () => moveDashboardCheckout(repo, previous, candidate, "deployment"),
        restoreUi: () => moveDashboardCheckout(repo, candidate, previous, "deployment", true),
        publishUiAt: (_args: unknown, revision: string, publish: () => Promise<void>) => withDashboardCheckout(repo, revision, "deployment", publish),
        typecheck: async () => { execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit"], { cwd: repo }); },
        test: async () => { assertRunning(); await verifyViews("A"); },
        health: async () => {
          const state = await health();
          assert.equal(state.instanceId, baseline.instanceId); assert.equal(state.revision, previous);
          assertRunning();
          if (!inspected && state.callsView.revision === uiRelease.candidate.revisions.callsView) {
            inspected = true;
            assert.equal(state.adminView.revision, uiRelease.candidate.revisions.adminView);
            await verifyViews("B");
            if (rejectPublication) throw new Error("Fixture interrupted publication verification");
          }
          return state;
        },
      } }).then((result: { result: string; candidateError?: string; reason?: string }) => { assert.ok(inspected, result.candidateError || result.reason); return result; });
    };
    const rolledBack = await transaction(true);
    assert.equal(rolledBack.result, "rolled_back");
    assert.match(rolledBack.candidateError ?? "", /Fixture interrupted publication verification/);
    assert.equal(git("rev-parse", "HEAD"), previous); await verifyViews("A");
    assert.equal((await transaction(false)).result, "updated");
    assert.equal(git("rev-parse", "HEAD"), candidate); await verifyViews("B");
    assertRunning();
    assert.equal((await health()).instanceId, baseline.instanceId);
  } finally {
    writeFileSync(go, "finish"); await run; await useFakeRuntime(null);
  }
  assert.equal(backend.calls.spawn.length, 1);
  assert.equal(messages.filter(text => text.includes(answer)).length, 1);
  assert.deepEqual(reactions, ["add", "remove"]);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM active_runs").get().n, 0);
});
