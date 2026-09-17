import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, stat, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArgs, createVpnService, SERVICE_LABEL, serviceIdentity, selectedCredentials, serviceFingerprint, privateDirectory, readPrivate, writePrivate, runCommand } from "../src/gateway/vpn-service.js";

const identity = serviceIdentity("/private/gateway","C-TEST","test-database");
const config = {dbHost:"10.20.30.40",dbPort:3306};
const id = "a".repeat(64);
const fingerprint = "reviewed";
const owned = (role,running = true) => ({Id:role === "vpn" ? id : "b".repeat(64),Config:{Labels:{[SERVICE_LABEL]:identity.owner,"cg.service.role":role,"cg.service.fingerprint":fingerprint}},State:{Running:running,Status:running?"running":"exited"},HostConfig:{NetworkMode:`container:${id}`}});
function fake({foreign=false,healthy=true,existing=false} = {}) {
  const calls = [], containers = new Map(existing ? [[identity.vpn,owned("vpn")],[identity.extractor,owned("extractor")]] : []);
  if(foreign)containers.set(identity.extractor,{...owned("extractor"),Config:{Labels:{}}});
  const run = async (_bin,args) => {
    calls.push(args);
    if(args[0]==="container")return {code:containers.has(args[2])?0:1};
    if(args[0]==="inspect")return {code:0,stdout:JSON.stringify([containers.get(args[1])])};
    if(args[0]==="rm"){for(const [name,data] of containers)if(data.Id===args[2])containers.delete(name);return {code:0};}
    if(args[0]==="run"){
      const name=args[args.indexOf("--name")+1];
      containers.set(name,owned(name===identity.vpn?"vpn":"extractor"));return {code:0,stdout:id};
    }
    if(args[0]==="exec")return {code:healthy?0:1,stdout:'{"select1":true}'};
    throw new Error("Unexpected fake command");
  };
  return {calls,containers,run};
}

test("privilege and secret separation: only VPN receives TUN/NET_ADMIN; no host socket, publish or engine label",()=>{
  const opts={identity,config,serviceDir:"/private/service",imageId:"sha256:"+id,fingerprint,vpnId:id};
  const vpn=createArgs(opts,"vpn"), extractor=createArgs(opts,"extractor");
  assert.ok(vpn.includes("--cap-add=NET_ADMIN"));assert.ok(vpn.includes("--device=/dev/net/tun"));
  assert.ok(vpn.includes("--network=slirp4netns:allow_host_loopback=false"));
  assert.ok(extractor.includes(`--network=container:${id}`));
  for(const args of [vpn,extractor]) {
    assert.ok(args.includes("--cap-drop=ALL"));assert.ok(args.includes("--read-only"));
    assert.doesNotMatch(args.join(" "),/cg\.install=|docker\.sock|podman\.sock|--privileged|--publish|--network=host/);
  }
  assert.doesNotMatch(extractor.join(" "),/NET_ADMIN|\/dev\/net\/tun|client.ovpn|\/vpn\/auth/);
  assert.doesNotMatch(vpn.join(" "),/credentials.json/);
});

test("credential selection never includes unrelated channel variables or permits auth-file injection",()=>{
  const env={VPN_USERNAME:"user",VPN_PASSWORD:"password",MYSQL_USERNAME:"reader",MYSQL_PASSWORD:"mysqlpass",UNRELATED_TOKEN:"excluded"};
  const {selected,missing}=selectedCredentials(env);
  assert.deepEqual(missing,[]);assert.equal(Object.keys(selected).length,4);
  assert.ok(!JSON.stringify(selected).includes("excluded"));
  assert.deepEqual(selectedCredentials({}).missing,["VPN_USERNAME","VPN_PASSWORD","MYSQL_USERNAME","MYSQL_PASSWORD"]);
  assert.throws(()=>selectedCredentials({...env,VPN_PASSWORD:"password\ninjected"}),/line break/);
  assert.notEqual(serviceFingerprint(config,selected,id,"private1"),serviceFingerprint(config,selected,id,"private2"));
});

test("foreign ownership is refused before either workload can be removed",async()=>{
  const f=fake({foreign:true,existing:true});
  const service=createVpnService({...f,identity,config,serviceDir:"/unused",imageId:id});
  await assert.rejects(service.stop(),/another workload/);
  assert.equal(f.calls.filter(args=>args[0]==="rm").length,0);
});

test("healthy unchanged service is reused without rewriting mounted credential files",async()=>{
  const f=fake({existing:true});
  const service=createVpnService({...f,identity,config,serviceDir:"/unused",imageId:id});
  assert.deepEqual(await service.start({fingerprint}),{reused:true});
  assert.equal(f.calls.filter(args=>["rm","run"].includes(args[0])).length,0);
});

test("VPN readiness failure never starts an extractor and removes only owned service containers",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"cg-vpn-service-"));
  try {
    const f=fake({healthy:false});
    const service=createVpnService({...f,identity,config,serviceDir:dir,imageId:id});
    await assert.rejects(service.start({fingerprint,auth:"u\np\n",database:{username:"r",password:"p"},profile:"client\n",attempts:1,wait:async()=>{}}),/did not become ready/);
    assert.equal(f.calls.filter(args=>args[0]==="run").length,1);
    assert.equal(f.containers.size,0);
    assert.equal((await stat(path.join(dir,"auth"))).mode&0o777,0o600);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("credential rotation recreates extractor first, then VPN, before mounting new auth files",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"cg-vpn-service-"));
  try {
    const f=fake({existing:true});
    const service=createVpnService({...f,identity,config,serviceDir:dir,imageId:id});
    const result=await service.start({fingerprint:"rotated",auth:"u\nnew\n",database:{username:"r",password:"new"},profile:"client\n"});
    assert.deepEqual(result,{reused:false});
    assert.deepEqual(f.calls.filter(args=>args[0]==="rm").map(args=>args[2]),["b".repeat(64),id]);
    assert.equal(f.calls.filter(args=>args[0]==="run").length,2);
    assert.equal(await readFile(path.join(dir,"auth"),"utf8"),"u\nnew\n");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("profile staging refuses symlinks and tightens regular files without following targets",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"cg-vpn-service-"));
  try {
    await privateDirectory(path.join(dir,"private"));
    const target=path.join(dir,"private","profile");
    await writePrivate(target,"sensitive");
    await symlink(target,path.join(dir,"link"));
    await assert.rejects(readPrivate(path.join(dir,"link")),/symbolic links/);
    await mkdir(path.join(dir,"real"));await symlink(path.join(dir,"real"),path.join(dir,"parent-link"));
    await assert.rejects(privateDirectory(path.join(dir,"parent-link","nested")),/symbolic links/);
    assert.equal(await readPrivate(target),"sensitive");
    assert.equal((await stat(target)).mode&0o777,0o600);
  } finally {await rm(dir,{recursive:true,force:true});}
});


test("command timeout forcibly ends a process that ignores SIGTERM", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cg-vpn-timeout-"));
  const marker = path.join(dir, "signal-state");
  try {
    const result = await runCommand(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      const marker = process.argv[1];
      process.on("SIGTERM", () => writeFileSync(marker, "term-ignored"));
      writeFileSync(marker, "ready");
      setInterval(() => {}, 1000);
    `, marker], { timeoutMs: 1000 });
    assert.equal(result.code, null, "the child must end by a signal, not a successful exit");
    assert.equal(await readFile(marker, "utf8"), "term-ignored", "SIGTERM was handled before SIGKILL ended the process");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
