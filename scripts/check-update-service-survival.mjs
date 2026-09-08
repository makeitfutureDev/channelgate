import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// Disposable, engine-independent systemd acceptance. Never targets a deployed service.
const repo = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'cg-update-survival-'));
const suffix = `${process.pid}-${Date.now()}`;
const parentUnit = `cg-update-fixture-parent-${suffix}`;
const runnerUnit = `cg-update-fixture-child-${suffix}`;
copyFileSync(path.join(repo, 'scripts/update-launcher.mjs'), path.join(root, 'update-launcher.mjs'));
writeFileSync(path.join(root, 'update-runner.mjs'), `
import { writeFileSync, readFileSync } from 'node:fs';
export async function main() {
 const root=process.env.CHANNELGATE_DIR;
 if(process.env.CG_UPDATE_OWNER_TOKEN !== 'synthetic-fixture-token' || process.env.FIXTURE_CHECK !== 'preserved') throw Error('environment mismatch');
 const cgroup = readFileSync('/proc/self/cgroup','utf8').trim();
 writeFileSync(root+'/child-ready.json', JSON.stringify({pid:process.pid,cgroup,environmentPreserved:true}));
 console.log('fixture child ready');
 await new Promise(resolve=>setTimeout(resolve, 2500));
 console.log('fixture child survived parent restart');
 writeFileSync(root+'/terminal.json',JSON.stringify({result:'updated',pid:process.pid,cgroup:readFileSync('/proc/self/cgroup','utf8').trim(),environmentPreserved:true}));
}
`, {mode:0o600});
writeFileSync(path.join(root, 'parent.mjs'), `
import {spawn} from 'node:child_process';
import {openSync,writeFileSync,readFileSync,existsSync,closeSync} from 'node:fs';
const root=${JSON.stringify(root)};
if (existsSync(root+'/parent-first.json')) {
 writeFileSync(root+'/parent-restarted.json',JSON.stringify({pid:process.pid,cgroup:readFileSync('/proc/self/cgroup','utf8').trim()}));
 setInterval(()=>{},1000);
} else {
 const fd=openSync(root+'/update.log','a',0o600);
 const child=spawn('systemd-run',['--user','--quiet','--pipe','--wait','--collect','--service-type=exec','--unit=${runnerUnit}',process.execPath,root+'/update-launcher.mjs','--transaction','fixture'],{detached:true,stdio:['pipe',fd,fd],env:{...process.env}});
 closeSync(fd);
 writeFileSync(root+'/parent-first.json',JSON.stringify({pid:process.pid,wrapperPid:child.pid,cgroup:readFileSync('/proc/self/cgroup','utf8').trim()}));
 child.stdin.on('error',()=>{});
 child.stdin.end(JSON.stringify({...process.env,CHANNELGATE_DIR:root,CG_UPDATE_OWNER_TOKEN:'synthetic-fixture-token',FIXTURE_CHECK:'preserved'}));
 child.unref();
 const timer=setInterval(()=>{if(existsSync(root+'/child-ready.json')) {clearInterval(timer);process.exit(1);}},50);
}
`, {mode:0o600});
function exec(command,args) { return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(`${command} failed (${code}): ${output}`)));});}
let started=false;
try {
 await exec('systemd-run',['--user','--quiet','--collect','--service-type=exec',`--unit=${parentUnit}`,'--property=KillMode=mixed','--property=Restart=on-failure','--property=RestartSec=100ms','--property=RuntimeMaxSec=15s',process.execPath,path.join(root,'parent.mjs')]);
 started=true;
 const deadline=Date.now()+12000;
 while(Date.now()<deadline && (!existsSync(path.join(root,'terminal.json')) || !existsSync(path.join(root,'parent-restarted.json')))) await new Promise(r=>setTimeout(r,100));
 const read=name=>JSON.parse(readFileSync(path.join(root,name),'utf8'));
 const parent=read('parent-first.json'), restarted=read('parent-restarted.json'), child=read('terminal.json');
 const log=readFileSync(path.join(root,'update.log'),'utf8');
 let wrapperAlive=true;try{process.kill(parent.wrapperPid,0);}catch{wrapperAlive=false;}
 if(parent.pid===restarted.pid || parent.cgroup===child.cgroup || !child.cgroup.includes(runnerUnit) || !log.includes('fixture child survived parent restart') || wrapperAlive || log.includes('synthetic-fixture-token')) throw Error('survival evidence did not meet pass rules');
 console.log(JSON.stringify({ok:true,root,parent,restarted,child,wrapperAlive,logSurvived:true,syntheticTokenLogged:log.includes('synthetic-fixture-token')},null,2));
} catch(error) {console.error(JSON.stringify({ok:false,root,error:error.message}));process.exitCode=1;}
finally {if(started) {await exec('systemctl',['--user','stop',parentUnit]).catch(()=>{});await exec('systemctl',['--user','stop',runnerUnit]).catch(()=>{});}}
