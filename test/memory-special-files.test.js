import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, truncate, readdir } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { applyMemoryOperations, MAX_MEMORY_FILE_BYTES } = await import("../src/gateway/channel-memory.js");
const moduleUrl = new URL("../src/gateway/channel-memory.js", import.meta.url).href;

function boundedChild(source, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Memory operation blocked on an untrusted file")); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

for (const kind of ["index", "topic"]) {
  test(`a FIFO ${kind} cannot block the daemon memory mutation`, async () => {
    const cwd = tempDir("cg-test-memory-fifo-");
    await mkdir(path.join(cwd, "memory"));
    const file = kind === "index" ? path.join(cwd, "MEMORY.md") : path.join(cwd, "memory", "note.md");
    execFileSync("mkfifo", [file]);
    const ops = kind === "index" ? [{ action: "add", text: "Fixture fact" }] : [{ action: "write_topic", topic: "note", content: "Fixture topic" }];
    const source = `import {applyMemoryOperations} from ${JSON.stringify(moduleUrl)}; try {await applyMemoryOperations(${JSON.stringify(cwd)}, {}, ${JSON.stringify(ops)}); process.exitCode=1;} catch(e) { if(!/regular file/.test(e.message)) throw e; process.stdout.write("refused-special-file"); }`;
    const result = await boundedChild(source);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /refused-special-file/);
  });

  test(`an oversized ${kind} is rejected without reading or rewriting its contents`, async () => {
    const cwd = tempDir("cg-test-memory-size-");
    await mkdir(path.join(cwd, "memory"));
    const file = kind === "index" ? path.join(cwd, "MEMORY.md") : path.join(cwd, "memory", "note.md");
    await writeFile(file, "fixture");
    await truncate(file, MAX_MEMORY_FILE_BYTES + 1);
    const ops = kind === "index" ? [{ action: "add", text: "Fixture fact" }] : [{ action: "write_topic", topic: "note", content: "Fixture topic" }];
    await assert.rejects(applyMemoryOperations(cwd, {}, ops), /8 MiB per-file I\/O limit/);
  });
}

test("oversized mutation input is rejected before creating memory files", async () => {
  const cwd = tempDir("cg-test-memory-input-");
  await assert.rejects(applyMemoryOperations(cwd, {}, [{ action: "write_topic", topic: "huge", content: "x".repeat(MAX_MEMORY_FILE_BYTES + 1) }]), /8 MiB/);
  assert.deepEqual(await readdir(cwd), []);
});

test("a changing memory parent cannot redirect reads, writes or rollback into an outside directory", async () => {
  const root = tempDir("cg-test-memory-parent-");
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const memory = path.join(cwd, "memory");
  await mkdir(memory, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "note.md"), "outside fixture unchanged");
  const ready = path.join(root, "ready");
  const stop = path.join(root, "stop");
  const source = `import fs from "node:fs"; const dir=${JSON.stringify(memory)}, out=${JSON.stringify(outside)}, backup=dir+"-saved"; fs.writeFileSync(${JSON.stringify(ready)},""); const until=Date.now()+1500; while(Date.now()<until&&!fs.existsSync(${JSON.stringify(stop)})) { try {if(fs.lstatSync(dir).isDirectory()) fs.renameSync(dir,backup);} catch{} try {fs.symlinkSync(out,dir);} catch{} try {if(fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir);} catch{} try {fs.renameSync(backup,dir);} catch{} }`;
  const worker = boundedChild(source, 3000);
  while (!(await readFile(ready).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    for (let n = 0; n < 60; n++) {
      await applyMemoryOperations(cwd, {}, [
        { action: "write_topic", topic: "note", content: `Workspace note ${n}` },
        { action: "add", text: `Workspace fact ${n}` },
      ]).catch(() => {}); // a concurrently replaced parent must fail closed
    }
  } finally { await writeFile(stop, "done"); await worker; }
  assert.equal(await readFile(path.join(outside, "note.md"), "utf8"), "outside fixture unchanged");
  assert.deepEqual(await readdir(outside), ["note.md"]);
});
