import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { readNoFollow } = await import("../src/gateway/safe-fs.js");

test("multiple FIFO reads cannot exhaust the async filesystem worker pool", async () => {
  const root = tempDir("cg-test-async-fifos-");
  const names = Array.from({ length: 8 }, (_, n) => path.join(root, `fifo-${n}`));
  for (const name of names) execFileSync("mkfifo", [name]);
  const regular = path.join(root, "regular.txt");
  await writeFile(regular, "regular file remains readable");
  const moduleUrl = new URL("../src/gateway/safe-fs.js", import.meta.url).href;
  const source = `import {readNoFollow} from ${JSON.stringify(moduleUrl)}; const blocked=Promise.allSettled(${JSON.stringify(names)}.map(readNoFollow)); const text=await readNoFollow(${JSON.stringify(regular)}); const outcomes=await blocked; if(outcomes.some(r=>r.status!=="rejected"||r.reason.code!=="ENOTREG")) throw new Error("special file not rejected"); process.stdout.write(text);`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("FIFO reads blocked the filesystem worker pool")); }, 2000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /regular file remains readable/);
});

test("ordinary files retain their contents and absent/link/directory reads retain their previous semantics", async () => {
  const root = tempDir("cg-test-managed-read-types-");
  const regular = path.join(root, "file.txt");
  const body = "ordinary content\n".repeat(10_000);
  await writeFile(regular, body);
  await mkdir(path.join(root, "dir"));
  await symlink(regular, path.join(root, "link"));
  assert.equal(await readNoFollow(regular), body);
  assert.equal(await readNoFollow(path.join(root, "missing")), null);
  assert.equal(await readNoFollow(path.join(root, "dir")), null);
  assert.equal(await readNoFollow(path.join(root, "link")), null);
});
