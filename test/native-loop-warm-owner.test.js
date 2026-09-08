import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tempDir } from "./helpers.js";
import { createSessionPool } from "../src/engines/session-pool.js";

const dir = tempDir("cg-loop-owner-");
const binary = path.join(dir, "claude");
writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const text=JSON.parse(line).message.content;
 if(text.startsWith('loop:')){
  const tool=text.slice(5), input=tool==='CronCreate'?{cron:'* * * * *',prompt:'next'}:tool==='CronDelete'?{id:'one'}:{delaySeconds:60,prompt:'next'};
  send({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:tool}}});
  send({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}}});
  send({type:'stream_event',event:{type:'content_block_stop',index:0}});
  setTimeout(()=>fs.writeFileSync(process.env.QA_NATIVE_WAKE_MARKER,'native timer fired'),150);
 }
 send({type:'result',result:JSON.stringify({text,pid:process.pid,args:process.argv.slice(2)}),session_id:'loop-session',subtype:'success'});
});
`);
chmodSync(binary, 0o755);
function setup(name) {
 const marker = path.join(dir, name);
 const pool = createSessionPool();
 const input = { key: name, cwd: dir, args: ["--session-id", "loop-session"], env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, QA_NATIVE_WAKE_MARKER: marker }, idleMs: 5000 };
 return { pool, input, marker };
}
for (const tool of ["ScheduleWakeup", "CronCreate", "CronDelete"]) {
 test(`completed ${tool} turn retires the native timer before daemon ownership`, async () => {
  const { pool, input, marker } = setup(tool);
  try {
   const events = [];
   const result = await pool.runPooled({ ...input, text: "loop:" + tool, onEvent: e => events.push(e) });
   assert.equal(JSON.parse(result.content).text, "loop:" + tool);
   assert.equal(events.filter(e => e.kind === "loop_wakeup").length, 1);
   await delay(250);
   assert.equal(existsSync(marker), false, "idle harness must not fire a second native tick");
   assert.equal(pool.poolStats().warm, 0);
  } finally { pool.shutdownPool(); }
 });
}
test("already queued follow-up resumes after pacing retirement without replaying the prior turn", async () => {
 const { pool, input, marker } = setup("queued");
 try {
  const first = pool.runPooled({ ...input, text: "loop:ScheduleWakeup" });
  const second = pool.runPooled({ ...input, text: "queued ordinary turn" });
  const [a,b] = (await Promise.all([first,second])).map(r => JSON.parse(r.content));
  assert.equal(b.text, "queued ordinary turn");
  assert.notEqual(a.pid,b.pid);
  assert.deepEqual(b.args,["-r","loop-session"]);
  await delay(250);
  assert.equal(existsSync(marker), false);
 } finally { pool.shutdownPool(); }
});
test("ordinary completed turns retain warm reuse", async () => {
 const { pool, input } = setup("ordinary");
 try {
  const first = JSON.parse((await pool.runPooled({...input,text:"one"})).content);
  const second = JSON.parse((await pool.runPooled({...input,text:"two"})).content);
  assert.equal(first.pid,second.pid);
  assert.equal(pool.poolStats().warm,1);
 } finally { pool.shutdownPool(); }
});
