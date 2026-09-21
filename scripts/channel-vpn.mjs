#!/usr/bin/env node
// Host-operator entry point. Can install a private standalone bundle beside an existing stable
// gateway without changing its checkout, its runtime image, or any ordinary channel container.
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { normalizeVpnProfile, validateVpnTarget } from "../src/gateway/vpn-profile.js";
import { SECRET_REFS, serviceIdentity, selectedCredentials, serviceFingerprint, createVpnService,
  plainPath, privateDirectory, readPrivate, writePrivate, runCommand, vpnUnitStatus, vpnFailureMessage, disableVpnUnit, vpnEnableRestartRequired, VPN_IMAGE, VPN_SERVICE_VERSION, vpnImageDigest, requireVpnImage } from "../src/gateway/vpn-service.js";

const bundleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const action = args.shift();
const allowed = new Set(["channel", "gateway-source", "profile", "project", "db-host", "db-port", "vpn-user-secret", "vpn-password-secret", "mysql-user-secret", "mysql-password-secret"]);
const opts = {};
const shutdown = new AbortController();
process.on("SIGTERM",()=>shutdown.abort());
process.on("SIGINT",()=>shutdown.abort());
for (let i=0;i<args.length;i+=2) {
  const key = args[i]?.replace(/^--/, "");
  if (!args[i]?.startsWith("--") || !allowed.has(key) || !args[i+1] || args[i+1].startsWith("--") || Object.hasOwn(opts,key)) {
    console.error("Invalid arguments. Use channel-vpn.mjs help."); process.exit(2);
  }
  opts[key] = args[i+1];
}
if (!action || action === "help") {
  console.log("Usage: node scripts/channel-vpn.mjs <configure|build|start|status|verify|query|stop|install-unit|enable|disable> --channel ID [--gateway-source /existing/gateway]");
  console.log("configure also requires --profile /channel/client.ovpn --project lowercase-name --db-host IPv4 [--db-port 3306].");
  console.log("Credentials are resolved only from the selected channel's Secrets: VPN_USERNAME, VPN_PASSWORD, MYSQL_USERNAME, MYSQL_PASSWORD.");
  process.exit(0);
}

function systemdWord(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid service argument.");
  return `"${value.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/%/g,"%%").replace(/\$/g,"$$")}"`;
}

async function main() {
  if (!["configure","build","start","supervise","status","verify","query","stop","install-unit","enable","disable"].includes(action)) throw new Error("Unknown service command.");
  if (!opts.channel || !/^[A-Za-z0-9:_-]{1,100}$/.test(opts.channel)) throw new Error("An exact registered channel ID is required.");
  const source = await plainPath(opts["gateway-source"] || bundleRoot);
  // Store imports use the selected gateway's own modules/schema, never a copied newer migration.
  const store = await import(pathToFileURL(path.join(source,"src/config/store.js")));
  const paths = await import(pathToFileURL(path.join(source,"src/config/paths.js")));
  const channelEnv = await import(pathToFileURL(path.join(source,"src/config/channel-env.js")));
  const entry = await store.getChannelEntry(opts.channel);
  if (!entry) throw new Error("Channel is not registered in this gateway.");
  let meta = await store.getChannelMeta(entry.slug);
  if (!meta) throw new Error("Channel has no configuration.");
  const root = await plainPath(paths.gatewayRoot());
  const dir = path.join(root,"services","vpn",serviceIdentity(root,opts.channel,"service").owner);
  const mutations = !["status","verify","query"].includes(action);
  if (mutations) await privateDirectory(dir);
  const lock = path.join(dir,["enable","disable"].includes(action) ? "control.lock" : "operation.lock");
  if (mutations && process.env.CG_VPN_LOCK_HELD !== lock) {
    // A kernel lock covers the entire supervisor lifetime and is released even after a crash.
    // --no-fork lets the wrapper forward shutdown directly to the supervised Node process.
    const code = await new Promise((resolve,reject)=>{
      const child = spawn("/usr/bin/flock",["--nonblock","--conflict-exit-code","75","--no-fork",lock,process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{
        stdio:"inherit",env:{...process.env,CG_VPN_LOCK_HELD:lock},
      });
      const terminate = ()=>child.kill("SIGTERM");
      process.on("SIGTERM",terminate); process.on("SIGINT",terminate);
      child.on("error",()=>reject(new Error("Could not acquire the service operation lock.")));
      child.on("close",result=>{process.off("SIGTERM",terminate);process.off("SIGINT",terminate);resolve(result ?? 1);});
    });
    if (code === 75) throw new Error("Service is supervised or another operation is active. Disable its user service before changing configuration or starting it manually.");
    process.exitCode = code; return;
  }
  {
    if (mutations) meta = await store.getChannelMeta(entry.slug);
    if (action === "configure") {
      if (!opts.profile || !opts.project) throw new Error("configure requires --profile and --project.");
      const identity = serviceIdentity(root,opts.channel,opts.project);
      const previous = meta.vpnService;
      if (previous && previous.project !== opts.project) throw new Error("Changing an existing project's name is not supported; stop and retire it explicitly first.");
      const target = validateVpnTarget(opts["db-host"],opts["db-port"] || 3306);
      const workspace = await plainPath(meta.workDir || paths.workspaceFolder(entry.slug,entry.platform));
      const profilePath = await plainPath(opts.profile);
      if (!profilePath.startsWith(`${workspace}${path.sep}`)) throw new Error("Profile must be a regular file inside the selected channel's working folder.");
      const normalized = normalizeVpnProfile(await readPrivate(profilePath,{tighten:true}),target);
      const refs = { ...SECRET_REFS };
      for (const [option,key] of Object.entries({"vpn-user-secret":"vpnUsername","vpn-password-secret":"vpnPassword","mysql-user-secret":"mysqlUsername","mysql-password-secret":"mysqlPassword"})) {
        if (opts[option]) refs[key] = opts[option];
      }
      selectedCredentials({},refs); // validate references without resolving values
      const profileRevision = createHash("sha256").update(normalized.config).digest("hex");
      const config = { version:1, project:opts.project, ...target, remote:normalized.remote, secrets:refs, profileRevision };
      await writePrivate(path.join(dir,`profile-${profileRevision}.ovpn`),normalized.config);
      await store.patchChannelMeta(entry.slug,{vpnService:config});
      meta = { ...meta,vpnService:config };
      console.log(JSON.stringify({configured:true,project:config.project,remote:config.remote,target,unit:identity.unit,credentials:inventory(meta,channelEnv,refs)},null,2));
      return;
    }
    const config = meta.vpnService;
    if (!config || config.version !== 1) throw new Error("Configure this channel's VPN service first.");
    validateVpnTarget(config.dbHost,config.dbPort);
    selectedCredentials({},config.secrets);
    const identity = serviceIdentity(root,opts.channel,config.project);
    const image = VPN_IMAGE;
    const imageDir = path.join(bundleRoot,"services/vpn-image");
    const service = createVpnService({identity,serviceDir:dir,config});
    if (action === "status") {
      const runtime = await service.status();
      if (runtime.vpn.state === "running" && runtime.extractor.state === "running") runtime.ready = await service.ready() && await service.routesReady();
      let last = {};
      try { last = JSON.parse(await readPrivate(path.join(dir,"status.json"),{maxBytes:4096})); } catch { /* absent/invalid status has no authority */ }
      const unit = await runCommand("/usr/bin/systemctl",["--user","show",identity.unit,"--property=LoadState,ActiveState,UnitFileState"],{timeoutMs:10_000}).catch(() => ({code:1,stdout:""}));
      const control = vpnUnitStatus(unit.stdout,runtime,last,unit.code === 0);
      try { await requireVpnImage(imageDir); } catch { control.state = "failed"; control.errorClass = "upgrade_required"; }
      console.log(JSON.stringify({...runtime,credentials:inventory(meta,channelEnv,config.secrets),unit:identity.unit,control},null,2));
      return;
    }
    const info = await runCommand("/usr/bin/podman",["info","--format","{{.Host.Security.Rootless}}"]);
    if (info.code !== 0 || info.stdout.trim() !== "true") throw new Error("This service requires a working rootless Podman runtime owned by the gateway operator.");
    if (action === "build") {
      const result = await runCommand("/usr/bin/podman",["build","--format","docker","--tag",image,"--label",`cg.vpn.version=${VPN_SERVICE_VERSION}`,"--label",`cg.vpn.digest=${await vpnImageDigest(imageDir)}`,"--file",path.join(imageDir,"Containerfile"),imageDir],{timeoutMs:600_000});
      if (result.code !== 0) throw new Error("VPN image build failed. Run podman build on services/vpn-image to inspect package/build diagnostics.");
      console.log(JSON.stringify({image,built:true})); return;
    }
    if (action === "stop") { await service.stop(); console.log("VPN and extractor stopped; profile and channel Secrets preserved."); return; }
    if (action === "verify") { console.log(JSON.stringify(await service.verify(),null,2)); return; }
    if (action === "query") {
      if (!meta.allowNetwork) throw new Error("Channel network policy is off.");
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 16 * 1024) throw new Error("Database request is too large.");
      }
      let request;
      try { request = JSON.parse(input); } catch { throw new Error("Invalid database request."); }
      const result = await service.query(request, {beforeExecute:async()=>Boolean((await store.getChannelMeta(entry.slug))?.allowNetwork)});
      console.log(JSON.stringify(result)); return;
    }
    if (action === "install-unit") {
      console.log(JSON.stringify(await installUnit({dir,identity,imageDir,root,source}))); return;
    }
    if (action === "enable" || action === "disable") {
      if (action === "enable") {
        if (!meta.allowNetwork) throw new Error("Channel network policy is off.");
        const expected = await runtimeInputs({dir,config,meta,channelEnv,imageDir,missingSuffix:"Service was not enabled."});
        // Refresh the protected supervisor from this reviewed checkout before any start. Existing
        // active services restart when their unit or protected runtime inputs changed.
        const current = await service.status();
        const priorUnit = await runCommand("/usr/bin/systemctl",["--user","show",identity.unit,"--property=ActiveState","--value"],{timeoutMs:10_000}).catch(() => ({code:1,stdout:""}));
        const unitWasActive = priorUnit.code === 0 && ["active","activating","reloading"].includes(priorUnit.stdout.trim());
        const installed = await installUnit({dir,identity,imageDir,root,source});
        const result = await runCommand("/usr/bin/systemctl",["--user","enable","--now",identity.unit],{timeoutMs:210_000});
        if (result.code !== 0) throw new Error("Service enable failed; check its status.");
        if (vpnEnableRestartRequired(current,{fingerprint:expected.fingerprint,imageId:expected.imageId,unitChanged:installed.changed,unitWasActive})) {
          const restarted = await runCommand("/usr/bin/systemctl",["--user","restart",identity.unit],{timeoutMs:210_000});
          if (restarted.code !== 0) throw new Error("VPN service refresh failed; check its status.");
        }
      } else {
        await disableVpnUnit({unit:identity.unit,stopArgs:[fileURLToPath(import.meta.url),"stop","--channel",opts.channel,"--gateway-source",source]});
        await writePrivate(path.join(dir,"status.json"),JSON.stringify({state:"off"}));
      }
      console.log(JSON.stringify({unit:identity.unit,enabled:action === "enable"})); return;
    }
    if (!meta.allowNetwork) throw new Error("Channel network policy is off; an administrator must enable it before starting the VPN.");
    const tun = await lstat("/dev/net/tun");
    if (!tun.isCharacterDevice()) throw new Error("Host TUN device is unavailable.");
    const {selected,imageId,profile,fingerprint} = await runtimeInputs({dir,config,meta,channelEnv,imageDir,missingSuffix:"No containers were changed."});
    const runtime = createVpnService({identity,serviceDir:dir,config,imageId});
    await writePrivate(path.join(dir,"status.json"),JSON.stringify({state:"starting"}));
    try {
      const result = await runtime.start({fingerprint,profile,signal:shutdown.signal,auth:`${selected.vpnUsername}\n${selected.vpnPassword}\n`,database:{username:selected.mysqlUsername,password:selected.mysqlPassword}});
      await writePrivate(path.join(dir,"status.json"),JSON.stringify({state:"on"}));
      console.log(JSON.stringify({...result,...(await runtime.status())},null,2));
      if (action === "supervise") {
        while (!shutdown.signal.aborted) {
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort",done); resolve(); };
            const timer = setTimeout(done,10_000);
            shutdown.signal.addEventListener("abort",done,{once:true});
          });
          if (shutdown.signal.aborted) break;
          const currentMeta = await store.getChannelMeta(entry.slug);
          if (!currentMeta?.allowNetwork) throw Object.assign(new Error(vpnFailureMessage("network_disabled")),{vpnErrorClass:"network_disabled"});
          const state = await runtime.status();
          if (state.vpn.state !== "running" || state.extractor.state !== "running" || !await runtime.routesReady() || !await runtime.ready()) throw Object.assign(new Error(vpnFailureMessage("connection_lost")),{vpnErrorClass:"connection_lost"});
        }
      }
    } catch (error) {
      await writePrivate(path.join(dir,"status.json"),JSON.stringify({state:"failed",errorClass:error.vpnErrorClass || "startup_failed"}));
      throw error;
    } finally { if (action === "supervise") await runtime.stop(); }
  }
}

async function runtimeInputs({dir,config,meta,channelEnv,imageDir,missingSuffix}) {
  const {selected,missing} = selectedCredentials(await resolveSelected(meta,channelEnv,config.secrets),config.secrets);
  if (missing.length) throw new Error(`Missing channel Secrets: ${missing.join(", ")}. ${missingSuffix}`);
  const imageId = await requireVpnImage(imageDir);
  let salt;
  try { salt = await readPrivate(path.join(dir,"fingerprint-key")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    salt = randomBytes(32).toString("hex");
    await writePrivate(path.join(dir,"fingerprint-key"),salt);
  }
  if (!/^[a-f0-9]{64}$/.test(config.profileRevision)) throw new Error("Profile revision is invalid; configure this service again.");
  const profile = await readPrivate(path.join(dir,`profile-${config.profileRevision}.ovpn`));
  if (createHash("sha256").update(profile).digest("hex") !== config.profileRevision) throw new Error("Protected profile revision changed; configure this service again.");
  return {selected,imageId,profile,fingerprint:serviceFingerprint({config,profile},selected,imageId,salt)};
}

async function installUnit({dir,identity,imageDir,root,source}) {
  // Copy only the reviewed helper's closure. No git checkout, channel credentials or other
  // gateway source is copied. The existing stable gateway remains on its exact revision.
  const closure = ["scripts/channel-vpn.mjs","src/gateway/vpn-service.js","src/gateway/vpn-profile.js"];
  const hash = createHash("sha256").update(await vpnImageDigest(imageDir));
  for (const file of closure) hash.update(await readPrivate(path.join(bundleRoot,file)));
  // Immutable bundles keep an already-running supervisor consistent during an upgrade.
  const installed = path.join(dir,"operator",hash.digest("hex").slice(0,24));
  if (path.resolve(bundleRoot) !== path.resolve(installed)) {
    const files = [...closure];
    for (const name of await readdir(imageDir)) {
      const data = await lstat(path.join(imageDir,name));
      if (data.isFile() && !/^(test|live_)/.test(name)) files.push(`services/vpn-image/${name}`);
    }
    for (const file of files) {
      const destination = path.join(installed,file);
      await privateDirectory(path.dirname(destination));
      await writePrivate(destination,await readPrivate(path.join(bundleRoot,file)),0o600);
    }
    await writePrivate(path.join(installed,"package.json"),'{"type":"module"}\n');
  }
  const unitDir = path.join(os.homedir(),".config/systemd/user");
  await privateDirectory(unitDir);
  const base = [process.execPath,path.join(installed,"scripts/channel-vpn.mjs")];
  const flags = ["--channel",opts.channel,"--gateway-source",source];
  const command = name => [...base,name,...flags].map(systemdWord).join(" ");
  const unit = `[Unit]\nDescription=ChannelGate isolated VPN and database extractor\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUMask=0077\nWorkingDirectory=${dir.replace(/%/g,"%%")}\nEnvironment=${systemdWord(`CHANNELGATE_DIR=${root}`)}\nExecStart=${command("supervise")}\nKillMode=mixed\nTimeoutStopSec=180\nRestart=no\n\n[Install]\nWantedBy=default.target\n`;
  let previous = "";
  try { previous = await readPrivate(path.join(unitDir,identity.unit)); } catch { /* first install */ }
  const changed = previous !== unit;
  await writePrivate(path.join(unitDir,identity.unit),unit);
  const result = await runCommand("/usr/bin/systemctl",["--user","daemon-reload"]);
  if (result.code !== 0) throw new Error("Unit written, but user systemd reload failed.");
  return {installed:true,changed,unit:identity.unit,operator:path.join(installed,"scripts/channel-vpn.mjs")};
}

function inventory(meta,channelEnv,refs) {
  const names = new Set(channelEnv.listChannelEnv(meta).map(item => item.name));
  return Object.values(refs).map(name => ({name,present:names.has(name)}));
}

function resolveSelected(meta,channelEnv,refs) {
  const env = {};
  for (const name of Object.values(refs)) if (Object.hasOwn(meta.env || {},name)) env[name] = meta.env[name];
  return channelEnv.resolveChannelEnv({env});
}

main().catch(error => {
  // Never relay provider/process output: it may include credentials or profile key material.
  const message = error instanceof Error && !error.code ? error.message : "Service operation failed (filesystem or runtime access).";
  console.error(message); process.exitCode = 1;
});
