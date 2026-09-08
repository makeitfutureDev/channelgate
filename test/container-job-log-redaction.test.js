import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { containerJobScript, parseContainerJobExit, stripContainerJobExit } = await import("../src/gateway/background.js");
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

test("detached job persists only redacted stdout and stderr across chunk boundaries", () => {
  const secret = randomBytes(24).toString("hex");
  const logFile = path.join(scratch, "split-output.log");
  const source = `const s=process.env.QA_CANARY;
    process.stdout.write('stdout '+s.slice(0,17));
    setTimeout(()=>process.stderr.write('stderr '+s.slice(0,21)),20);
    setTimeout(()=>process.stdout.write(s.slice(17)+' tail\\n'),40);
    setTimeout(()=>process.stderr.write(s.slice(21)+' tail\\n'),60);`;
  const script = containerJobScript(`node -e ${quote(source)}`, logFile, ["QA_CANARY"]);
  assert.equal(script.includes(secret), false, "values must never enter wrapper argv");
  const child = spawnSync("bash", ["-c", script], { env: { ...process.env, QA_CANARY: secret }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, "wrapper must finish successfully");
  const output = readFileSync(logFile, "utf8");
  assert.equal(output.includes(secret), false, "raw persisted log must never contain the canary");
  assert.equal(output.includes(secret.slice(0, 17)), false, "interleaving stderr must not expose stdout's held prefix");
  assert.equal((output.match(/\[REDACTED\]/g) || []).length, 2);
  assert.equal(parseContainerJobExit(output), 0);
  assert.match(stripContainerJobExit(output), /stdout \[REDACTED\] tail/);
  assert.match(stripContainerJobExit(output), /stderr \[REDACTED\] tail/);
  assert.equal(child.stdout.includes(secret) || child.stderr.includes(secret), false);
});

test("redacted detached log retains explicit failure status and quoted command/path", () => {
  const logFile = path.join(scratch, "o'ops log.txt");
  const child = spawnSync("bash", ["-c", containerJobScript("printf 'safe\\n'; exit 17", logFile)], { encoding: "utf8", timeout: 5000 });
  const output = readFileSync(logFile, "utf8");
  assert.equal(parseContainerJobExit(output), 17);
  assert.equal(stripContainerJobExit(output), "safe");
  assert.equal(child.status, 17);
});

test("detached redaction preserves unicode and the final short output tail", () => {
  const secret = "π-" + randomBytes(12).toString("hex");
  const logFile = path.join(scratch, "unicode.log");
  const source = `const b=Buffer.from(process.env.QA_CANARY);process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20);setTimeout(()=>process.stdout.write(' ok'),40);`;
  const child = spawnSync("bash", ["-c", containerJobScript(`node -e ${quote(source)}`, logFile, ["QA_CANARY"])], { env: { ...process.env, QA_CANARY: secret }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0);
  assert.equal(stripContainerJobExit(readFileSync(logFile, "utf8")), "[REDACTED] ok");
});

test("log is redacted while detached work outlives its launcher and keeps a recoverable failure code", async () => {
  const secret = randomBytes(24).toString("hex");
  const logFile = path.join(scratch, "orphan.log");
  const ready = path.join(scratch, "orphan-ready");
  const source = `const fs=require('fs');process.stdout.write('begin '+process.env.QA_CANARY+' '+'.'.repeat(100));fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{process.stdout.write('complete');process.exitCode=23},700);`;
  const script = containerJobScript(`node -e ${quote(source)}`, logFile, ["QA_CANARY"]);
  const launcher = `const {spawn}=require('child_process');const c=spawn('bash',['-c',${JSON.stringify(script)}],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`;
  const launched = spawnSync(process.execPath, ["-e", launcher], { env: { ...process.env, QA_CANARY: secret }, encoding: "utf8", timeout: 5000 });
  assert.equal(launched.status, 0);
  const pid = Number(launched.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  let exitedNaturally = false;
  const wrapperRunning = () => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Linux can retain an orphan as a zombie until its reaper runs. Its exit/coverage flush
      // is already complete then; kill(pid, 0) would incorrectly keep waiting for that zombie.
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  };
  try {
    for (let i = 0; i < 150 && !existsSync(ready); i++) await delay(10);
    assert.ok(existsSync(ready), "detached command starts after the launcher exits");
    let during = "";
    for (let i = 0; i < 40; i++) {
      during = readFileSync(logFile, "utf8");
      if (during.includes("[REDACTED]")) break;
      await delay(10);
    }
    assert.equal(during.includes(secret), false, "raw bytes must not briefly land on disk");
    assert.match(during, /begin \[REDACTED\]/);
    assert.equal(parseContainerJobExit(during), null, "still-running work has no fabricated terminal marker");
    let final = "";
    for (let i = 0; i < 200; i++) {
      final = readFileSync(logFile, "utf8");
      if (parseContainerJobExit(final) !== null) break;
      await delay(10);
    }
    assert.equal(parseContainerJobExit(final), 23);
    assert.equal(final.includes(secret), false);
    assert.match(stripContainerJobExit(final), /complete$/);
    // The terminal log marker precedes the Node wrapper's own exit. Killing it at that marker
    // can interrupt V8's coverage-file flush and fail the surrounding suite with an empty file.
    const exitDeadline = Date.now() + 5000;
    while (wrapperRunning() && Date.now() < exitDeadline) await delay(10);
    assert.equal(wrapperRunning(), false, "the detached wrapper must exit naturally after its terminal marker");
    exitedNaturally = true;
  } finally {
    if (!exitedNaturally) {
      try { process.kill(-pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
    }
  }
});
