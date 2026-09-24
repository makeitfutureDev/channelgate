import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createChannelVpnControl } = await import("../src/gateway/channel-vpn-control.js");
const { classifyVpnFailure, vpnUnitStatus, vpnFailureMessage, disableVpnUnit } = await import("../src/gateway/vpn-service.js");
const { register } = await import("../src/mcp/tools/channel-admin.js");

function fixture() {
  const f = { calls: [], events: [], meta: { allowNetwork:true, vpnService:{version:1} }, state:"off", names:["VPN_USERNAME","VPN_PASSWORD","MYSQL_USERNAME","MYSQL_PASSWORD"] };
  f.control = createChannelVpnControl({
    entryFor: async id => id === "C_VPN" ? {slug:"vpn-test"} : null,
    metaFor: async () => f.meta,
    inventory: () => f.names.map(name=>({name})),
    audit: async (...event)=>f.events.push(event),
    execute: async (action,id) => {
      f.calls.push([action,id]);
      if (f.execute) return f.execute(action,id);
      if (action === "enable") f.state="starting";
      if (action === "disable") f.state="off";
      return {code:0,stdout:JSON.stringify({control:{available:true,installed:true,enabled:f.state!=="off",state:f.state},password:"must-not-leak",credentials:[{name:"SECRET",value:"must-not-leak"}]})};
    },
  });
  return f;
}
const allowed = {actor:"U_MANAGER",source:"test",authorize:async()=>true};

test("unconfigured and unknown channels do not spawn a host helper", async()=>{
  const f=fixture(); f.meta.vpnService=null;
  assert.equal((await f.control.getStatus("C_VPN")).state,"unconfigured");
  await assert.rejects(f.control.getStatus("C_OTHER"),{statusCode:404});
  await assert.rejects(f.control.getStatus("C_VPN;sh"),{statusCode:400});
  await assert.rejects(f.control.setEnabled("C_VPN",true,allowed),/not configured/);
  assert.equal(f.calls.length,0);
});

test("responses are allowlisted and start returns connecting, not a successful connection",async()=>{
  const f=fixture();
  const status=await f.control.setEnabled("C_VPN",true,allowed);
  assert.equal(status.state,"starting"); assert.equal(status.enabled,true);
  assert.doesNotMatch(JSON.stringify(status),/must-not-leak|password|SECRET/);
  assert.deepEqual(f.calls,[['enable','C_VPN'],['status','C_VPN']]);
  assert.ok(f.events.some(([event,data])=>event==='channel_vpn_controlled'&&data.author==='U_MANAGER'&&data.enabled===true));
  assert.equal((await f.control.setEnabled("C_VPN",false,allowed)).state,"off");
});

test("missing credentials and Network off block enable, but never block stop",async()=>{
  const f=fixture(); f.names=[];
  await assert.rejects(f.control.setEnabled("C_VPN",true,allowed),/Missing channel Secrets/);
  f.meta.allowNetwork=false;
  await assert.rejects(f.control.setEnabled("C_VPN",true,allowed),/Turn on Network/);
  assert.equal(f.calls.length,0);
  await f.control.setEnabled("C_VPN",false,allowed);
  assert.equal(f.calls[0][0],"disable");
});

test("authorization is mandatory and rechecked after queuing at the effect boundary",async()=>{
  const f=fixture();
  await assert.rejects(f.control.setEnabled("C_VPN",true),{statusCode:403});
  let n=0;
  await assert.rejects(f.control.setEnabled("C_VPN",true,{authorize:async()=>++n===1}),{statusCode:403});
  assert.equal(f.calls.length,0);
});

test("concurrent toggles serialize and cannot use stale permission",async()=>{
  const f=fixture(); let finish, entered;
  const inCommand=new Promise(resolve=>{entered=resolve;});
  const command=new Promise(resolve=>{finish=resolve;});
  f.execute=async action=>{if(action==='enable'){entered();await command;}return {code:0,stdout:JSON.stringify({control:{available:true,installed:true,state:'starting',enabled:true}})};};
  const first=f.control.setEnabled("C_VPN",true,allowed);
  await inCommand;
  let permitted=true;
  const second=f.control.setEnabled("C_VPN",false,{authorize:async()=>permitted});
  await new Promise(resolve=>setImmediate(resolve));
  permitted=false; finish();
  await first; await assert.rejects(second,{statusCode:403});
  assert.equal(f.calls.filter(([a])=>a==='disable').length,0);
});

test("raw subprocess errors and malformed status never disclose provider output",async()=>{
  const f=fixture();f.execute=async()=>({code:1,stdout:'token=PRIVATE',stderr:'password=PRIVATE'});
  assert.equal((await f.control.getStatus('C_VPN')).state,'unavailable');
  await assert.rejects(f.control.setEnabled('C_VPN',true,allowed),e=>e.statusCode===503&&!e.message.includes('PRIVATE'));
  f.execute=async()=>({code:0,stdout:JSON.stringify({control:{available:true,installed:true,state:'failed',enabled:true,errorClass:'token=PRIVATE'}})});
  const status=await f.control.getStatus('C_VPN');
  assert.equal(status.state,'failed'); assert.doesNotMatch(JSON.stringify(status),/PRIVATE/);
});

test("a failed toggle names the helper's fixed failure class, never its free text",async()=>{
  const f=fixture();
  f.execute=async()=>({code:1,stdout:'{"errorClass":"upgrade_required"}\n',stderr:'Build the current OpenVPN 3 service image'});
  await assert.rejects(f.control.setEnabled('C_VPN',true,allowed),e=>e.statusCode===503&&e.message===vpnFailureMessage('upgrade_required'));
  assert.ok(f.events.some(([event,data])=>event==='channel_vpn_control_failed'&&data.errorClass==='upgrade_required'));
  for (const stdout of ['{"errorClass":"token=PRIVATE"}','{"errorClass":"__proto__"}','PRIVATE {"errorClass":"upgrade_required"}','']) {
    f.events.length=0; f.execute=async()=>({code:1,stdout,stderr:'password=PRIVATE'});
    await assert.rejects(f.control.setEnabled('C_VPN',true,allowed),e=>/Could not change VPN state/.test(e.message)&&!e.message.includes('PRIVATE'));
    assert.ok(f.events.every(([,data])=>!('errorClass' in data)));
  }
});

test("server errors reduce to fixed diagnostics; TLS verification is preserved",()=>{
  assert.equal(classifyVpnFailure('secret=PRIVATE\nVERIFY KU ERROR'),'server_certificate_usage');
  assert.match(vpnFailureMessage('server_certificate_usage'),/Key Usage/);
  for (const errorClass of ['server_certificate_usage','server_certificate_invalid','tls_failed','authentication_failed']) {
    assert.equal(classifyVpnFailure(JSON.stringify({event:'vpn_error',errorClass})),errorClass);
  }
  assert.equal(classifyVpnFailure('AUTH_FAILED user=PRIVATE'),'authentication_failed');
  assert.doesNotMatch(vpnFailureMessage('PRIVATE'),/PRIVATE/);
  assert.equal(typeof vpnFailureMessage('__proto__'),'string');
  const running={vpn:{state:'running'},extractor:{state:'running'}};
  const status=(active,last={})=>vpnUnitStatus(`LoadState=loaded\nActiveState=${active}\nUnitFileState=enabled`,running,last);
  assert.equal(status('active').state,'starting');
  assert.equal(status('active',{state:'on'}).state,'failed');
  running.vpn.health='unhealthy';
  assert.equal(status('active',{state:'on'}).errorClass,'connection_lost');
  running.ready=true;
  assert.equal(status('active',{state:'on'}).state,'on');
  assert.equal(status('failed',{errorClass:'server_certificate_usage'}).errorClass,'server_certificate_usage');
  assert.equal(status('failed',{errorClass:'PRIVATE'}).errorClass,'startup_failed');
  assert.equal(status('deactivating').state,'stopping');
  assert.equal(vpnUnitStatus('LoadState=not-found').installed,false);
});

test("MCP VPN operations stay bound to current channel and recheck access/management",async()=>{
  const tools=new Map(), calls=[];
  let access=true,manager=true,valid=true;
  register({registerTool:(name,_schema,handler)=>tools.set(name,handler)}, {
    channelId:'C_VPN',slug:'vpn-test',createdBy:'U_MANAGER',text:t=>t,
    verifyCapability:()=>({ok:valid}),requireChannelAccess:async()=>access,requireManage:async()=>manager,
    vpnControl:{getStatus:async id=>{calls.push(['read',id]);return {state:'off'};},setEnabled:async(id,enabled,options)=>{
      assert.equal(await options.authorize(),true);calls.push(['write',id,enabled]);return {state:'starting'};
    }},
  });
  await tools.get('get_channel_vpn_status')({channelId:'C_OTHER'});
  await tools.get('set_channel_vpn')({channelId:'C_OTHER',enabled:true});
  assert.deepEqual(calls,[['read','C_VPN'],['write','C_VPN',true]]);
  manager=false; await tools.get('set_channel_vpn')({enabled:false});
  access=false; await tools.get('get_channel_vpn_status')({});
  valid=false; await tools.get('set_channel_vpn')({enabled:true});
  assert.equal(calls.length,2);
});


test("OFF stops the supervisor before locked manual-pair cleanup and propagates failures",async()=>{
  const calls=[];
  const opts={unit:"fixture.service",stopArgs:["fixed-helper","stop","--channel","C_VPN"],run:async(bin,args)=>{calls.push([bin,args]);return {code:0};}};
  await disableVpnUnit(opts);
  assert.deepEqual(calls[0],["/usr/bin/systemctl",["--user","disable","--now","fixture.service"]]);
  assert.deepEqual(calls[1],[process.execPath,opts.stopArgs]);
  let count=0;
  await assert.rejects(disableVpnUnit({...opts,run:async()=>({code:++count===1?0:75})}),/could not be stopped/);
  count=0;
  await assert.rejects(disableVpnUnit({...opts,run:async()=>{count++;return {code:1};}}),/disable failed/);
  assert.equal(count,1);
  assert.equal(vpnUnitStatus("LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled",{vpn:{state:"running"},extractor:{state:"absent"}}).running,true);
});
