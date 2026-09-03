import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const [{ toolchainLauncherEntries, toolchainReadPaths, TOOLCHAIN_BINS }, { buildSettings }, { saveSettings }, { gatewayRoot }] =
  await Promise.all([
    import("../src/gateway/toolchain-paths.js"),
    import("../src/gateway/folders.js"),
    import("../src/config/settings.js"),
    import("../src/config/paths.js"),
  ]);

const sandboxPath = (p) => `/${p.replace(/^\/+/, "")}`;

// A synthetic install that mirrors how Linux hosts actually lay this out, and which the sandbox
// masks wholesale: a per-user bin dir of SYMLINKS into a Node prefix, plus one real binary.
//
//   <home>/.local/bin/node   -> <home>/.local/node/bin/node
//   <home>/.local/bin/npm    -> <home>/.local/node/lib/node_modules/npm/bin/npm-cli.js
//   <home>/.local/bin/vercel -> <home>/.local/node/lib/node_modules/vercel/dist/vc.js
//   <home>/.local/bin/gh        (a real file, no indirection)
//   <home>/.local/share/secrets (app data — must stay invisible)
function fakeHome() {
  const home = tempDir("cg-toolchain-");
  const bin = path.join(home, ".local", "bin");
  const prefixBin = path.join(home, ".local", "node", "bin");
  const modules = path.join(home, ".local", "node", "lib", "node_modules");
  for (const d of [bin, prefixBin, path.join(modules, "npm", "bin"), path.join(modules, "vercel", "dist")]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  writeFileSync(path.join(home, ".local", "share", "secrets"), "token");

  const exe = (p) => {
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  };
  exe(path.join(prefixBin, "node"));
  exe(path.join(modules, "npm", "bin", "npm-cli.js"));
  exe(path.join(modules, "vercel", "dist", "vc.js"));
  exe(path.join(bin, "gh"));
  symlinkSync(path.join(prefixBin, "node"), path.join(bin, "node"));
  symlinkSync(path.join(modules, "npm", "bin", "npm-cli.js"), path.join(bin, "npm"));
  symlinkSync(path.join(modules, "vercel", "dist", "vc.js"), path.join(bin, "vercel"));

  return { home, bin, prefix: path.join(home, ".local", "node"), execPath: path.join(prefixBin, "node") };
}

// A grant covers a target when it IS that path or an ancestor directory of it.
const covers = (paths, target) => paths.some((p) => target === p || target.startsWith(`${p}${path.sep}`));

test("the whole Node prefix is granted, not just the node binary", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin] });
  // npm/npx and every globally-installed CLI are JS files under prefix/lib/node_modules reached
  // through a shim in prefix/bin — granting only the `node` executable leaves them unresolvable.
  assert.ok(paths.includes(fx.prefix), "the Node install prefix must be readable");
});

test("a symlinked binary grants the link AND makes its target reachable", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin] });
  // The sandbox refuses at the link itself, long before the allowed destination is reached.
  assert.ok(paths.includes(path.join(fx.bin, "npm")), "the PATH entry (symlink) must be granted");
  // Reachable, not necessarily listed: in this layout the prefix grant already absorbs the target.
  const target = path.join(fx.prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  assert.ok(covers(paths, target), "the symlink target must be reachable too");
});

test("Codex launcher entries point directly at real package files", () => {
  const fx = fakeHome();
  const entries = toolchainLauncherEntries({ home: fx.home, dirs: [fx.bin] });
  const npm = entries.find((entry) => entry.name === "npm");
  assert.deepEqual(npm, {
    name: "npm",
    target: path.join(fx.prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  });
});

test("a real (non-symlink) binary is granted as itself", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin] });
  assert.ok(paths.includes(path.join(fx.bin, "gh")));
});

test("the grant is surgical: app data next to the binaries is never exposed", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin] });
  // ~/.local/share holds application secrets. Granting ~/.local wholesale would hand them over.
  assert.ok(!paths.includes(path.join(fx.home, ".local")), "~/.local must never be granted wholesale");
  assert.ok(!paths.some((p) => p.startsWith(path.join(fx.home, ".local", "share"))), "~/.local/share must stay masked");
  assert.ok(!paths.includes(fx.bin), "the bin DIRECTORY is not granted — only the binaries in it");
});

// The npm global root does NOT always live under the Node prefix. `~/.local/node` + a prefix-local
// `lib/node_modules` is one layout; `~/.local/node` + a SEPARATE `~/.local/lib/node_modules` is
// another, and both are in use on the same machine here. The second is what the first cut of this
// module got wrong: the prefix grant covered the package on one box and missed it on the other.
function fakeHomeSplitGlobals() {
  const home = tempDir("cg-toolchain-split-");
  const bin = path.join(home, ".local", "bin");
  const prefixBin = path.join(home, ".local", "node", "bin");
  const pkg = path.join(home, ".local", "lib", "node_modules", "vercel");
  for (const d of [bin, prefixBin, path.join(pkg, "dist", "chunks")]) mkdirSync(d, { recursive: true });

  const exe = (p) => {
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  };
  exe(path.join(prefixBin, "node"));
  exe(path.join(pkg, "dist", "vc.js"));
  // The siblings the shim reaches for. Masking these is what makes a CLI start and then die.
  writeFileSync(path.join(pkg, "dist", "index.js"), "module.exports = {}\n");
  writeFileSync(path.join(pkg, "dist", "chunks", "chunk.js"), "module.exports = {}\n");
  symlinkSync(path.join(prefixBin, "node"), path.join(bin, "node"));
  symlinkSync(path.join(pkg, "dist", "vc.js"), path.join(bin, "vercel"));

  return { home, bin, pkg, prefix: path.join(home, ".local", "node"), execPath: path.join(prefixBin, "node") };
}

test("a CLI installed outside the Node prefix grants its PACKAGE, not just the shim", () => {
  const fx = fakeHomeSplitGlobals();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin], integrations: ["vercel"] });
  // The shim is one file that reaches the rest of its package by relative import. Granting only
  // the shim resolves the binary and then dies on its first require — the failure this guards.
  assert.ok(covers(paths, path.join(fx.pkg, "dist", "index.js")), "the shim's siblings must be readable");
  assert.ok(covers(paths, path.join(fx.pkg, "dist", "chunks", "chunk.js")), "nested package files too");
  assert.ok(paths.includes(path.join(fx.bin, "vercel")), "the PATH entry is still granted");
});

test("a package root grant stops at the package, never the whole node_modules tree", () => {
  const fx = fakeHomeSplitGlobals();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin], integrations: ["vercel"] });
  const modules = path.join(fx.home, ".local", "lib", "node_modules");
  assert.ok(!paths.includes(modules), "every other globally-installed package stays masked");
  assert.ok(!paths.includes(path.join(fx.home, ".local", "lib")), "and its parent with it");
});

test("the emitted list is minimal: nothing already covered by a granted directory", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin], integrations: ["vercel"] });
  for (const p of paths) {
    assert.ok(!paths.some((other) => other !== p && covers([other], p)), `${p} is redundant — already covered`);
  }
  // In the prefix-local layout the prefix absorbs npm and vercel, so only the prefix survives.
  assert.ok(paths.includes(fx.prefix));
  assert.ok(!paths.some((p) => p.startsWith(path.join(fx.prefix, "lib"))), "prefix-internal paths are absorbed");
});

test("only an ENABLED integration makes its CLI reachable", () => {
  const fx = fakeHome();
  const off = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin] });
  assert.ok(!off.includes(path.join(fx.bin, "vercel")), "a disabled integration grants nothing");

  const on = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin], integrations: ["vercel"] });
  assert.ok(on.includes(path.join(fx.bin, "vercel")), "enabling Vercel must make the binary reachable");
  assert.ok(covers(on, path.join(fx.prefix, "lib", "node_modules", "vercel", "dist", "vc.js")), "and its shim target with it");
});

test("junk in the integrations list is ignored rather than throwing", () => {
  const fx = fakeHome();
  const paths = toolchainReadPaths({
    home: fx.home,
    execPath: fx.execPath,
    dirs: [fx.bin],
    integrations: ["nope", 7, null, "VERCEL"],
  });
  assert.ok(paths.includes(path.join(fx.bin, "vercel")), "case-insensitive known ids still resolve");
});

test("paths outside HOME are dropped — only the read-denied tree needs re-allowing", () => {
  const fx = fakeHome();
  const elsewhere = tempDir("cg-usrbin-");
  writeFileSync(path.join(elsewhere, "git"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(elsewhere, "git"), 0o755);

  const paths = toolchainReadPaths({ home: fx.home, execPath: fx.execPath, dirs: [fx.bin, elsewhere] });
  assert.ok(!paths.some((p) => p.startsWith(elsewhere)), "a /usr/bin-style tool is already readable; do not list it");
});

test("a binary inside the gateway root is never granted", () => {
  const fx = fakeHome();
  // The gateway root holds every channel's config and tokens. A toolchain grant must not be a way
  // in, even if someone installs a CLI there.
  const root = path.join(fx.home, ".claude-gateway");
  const rootBin = path.join(root, "bin");
  mkdirSync(rootBin, { recursive: true });
  writeFileSync(path.join(rootBin, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(rootBin, "node"), 0o755);

  const paths = toolchainReadPaths({ home: fx.home, root, execPath: path.join(rootBin, "node"), dirs: [rootBin] });
  assert.deepEqual(paths, [], "nothing inside the gateway root may be re-allowed");
});

test("a missing binary is skipped silently — no throw, no phantom path", () => {
  const empty = tempDir("cg-empty-");
  const home = tempDir("cg-barehome-");
  assert.deepEqual(toolchainReadPaths({ home, execPath: path.join(empty, "node"), dirs: [empty] }), []);
  assert.ok(TOOLCHAIN_BINS.includes("node"), "node is the one binary the baseline cannot omit");
});

// --- wiring into the lockdown -------------------------------------------------------------
// These run against the REAL host layout (buildSettings reads os.homedir() directly), so on a
// machine whose toolchain lives outside HOME the expected set is empty and the inclusion checks
// hold vacuously. The fixture tests above carry the resolution coverage; these prove the wiring:
// which modes get the grant, and that it never leaks into writes.

async function settingsFor(meta) {
  return buildSettings({ _slug: "toolchain-probe", allowedMcps: [], ...meta });
}

function hostExpected() {
  return toolchainReadPaths({ root: gatewayRoot() }).map(sandboxPath);
}

test("a Bash channel can reach the toolchain; a read-only channel cannot", async () => {
  const expected = hostExpected();

  const bash = await settingsFor({ allowBash: true });
  for (const p of expected) assert.ok(bash.sandbox.filesystem.allowRead.includes(p), `${p} must be readable`);

  const readOnly = await settingsFor({ allowBash: false, autoMode: false });
  for (const p of expected) {
    assert.ok(!readOnly.sandbox.filesystem.allowRead.includes(p), `${p} must not leak into a read-only channel`);
  }
});

test("the toolchain grant is not gated on network — `node build.js` works with egress off", async () => {
  const expected = hostExpected();
  const s = await settingsFor({ allowBash: true, allowNetwork: false });
  assert.equal(s.sandbox.network, undefined);
  for (const p of expected) assert.ok(s.sandbox.filesystem.allowRead.includes(p), `${p} must be readable offline too`);
});

test("the grant is read-only: the toolchain never becomes writable", async () => {
  const s = await settingsFor({ allowBash: true, allowNetwork: true });
  for (const p of hostExpected()) {
    assert.ok(!(s.sandbox.filesystem.allowWrite || []).includes(p), `${p} must never be writable`);
  }
  // The delayed-escape protection is what makes the read grant safe: plant-a-binary-now,
  // run-it-unsandboxed-later stays closed because these stay on the enumerated write-deny list.
  const home = os.homedir();
  for (const rel of ["bin", ".local"]) {
    assert.ok(s.sandbox.filesystem.denyWrite.includes(sandboxPath(path.join(home, rel))), `~/${rel} must be write-denied`);
  }
});

test("auto mode counts as write-capable for the toolchain grant, same as Bash", async () => {
  const expected = hostExpected();
  const s = await settingsFor({ autoMode: true });
  for (const p of expected) assert.ok(s.sandbox.filesystem.allowRead.includes(p), `${p} must be readable in auto mode`);
});

// --- the Claude launcher directory ---------------------------------------------------------
// Regression (CLI-12, 2026-09-01): per-file allowRead grants materialize as binds, and a SYMLINK
// entry cannot be bound — a host whose ~/.local/bin shims are symlinks loses every shim inside
// the sandbox while plain binaries survive. The stable launcher dir + PATH prepend is the remedy.

const [{ materializeStableToolchainLaunchers }, { buildClaudeEnv }] = await Promise.all([
  import("../src/gateway/run-grant-artifacts.js"),
  import("../src/engines/claude.js"),
]);
const { readlinkSync, lstatSync } = await import("node:fs");

test("the stable launcher dir holds direct symlinks to resolved targets and is idempotent", async () => {
  const fx = fakeHome();
  const dir = await materializeStableToolchainLaunchers({ home: fx.home, dirs: [fx.bin] });
  assert.ok(dir.startsWith(path.join(gatewayRoot(), "runtime", "toolchain-bin")), "must live under the gateway runtime container");
  assert.ok(lstatSync(path.join(dir, "npm")).isSymbolicLink());
  assert.equal(readlinkSync(path.join(dir, "npm")), path.join(fx.prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  // Content-addressed: the same toolchain resolves to the same directory, so settings digests and
  // warm fingerprints stay stable until the host toolchain actually changes.
  assert.equal(await materializeStableToolchainLaunchers({ home: fx.home, dirs: [fx.bin] }), dir);
});

test("an empty toolchain materializes nothing", async () => {
  const empty = tempDir("cg-none-");
  assert.equal(await materializeStableToolchainLaunchers({ home: empty, dirs: [path.join(empty, "bin")] }), "");
});

test("buildClaudeEnv prepends the launcher dir to PATH; a channel secret cannot override it", () => {
  const env = buildClaudeEnv(
    { toolchainBinDir: "/g/runtime/toolchain-bin/abc", extraEnv: { PATH: "/evil" } },
    { PATH: "/usr/bin:/bin" },
  );
  assert.equal(env.PATH, "/g/runtime/toolchain-bin/abc:/usr/bin:/bin");
  const plain = buildClaudeEnv({}, { PATH: "/usr/bin:/bin" });
  assert.equal(plain.PATH, "/usr/bin:/bin");
});

test("write-capable channels re-allow the launcher container; read-only channels do not", async () => {
  const container = sandboxPath(path.join(gatewayRoot(), "runtime", "toolchain-bin"));
  const bash = await settingsFor({ allowBash: true });
  assert.ok(bash.sandbox.filesystem.allowRead.includes(container), "bash channels must see the launcher dir");
  const readOnly = await settingsFor({ allowBash: false, autoMode: false });
  assert.ok(!readOnly.sandbox.filesystem.allowRead.includes(container), "read-only channels must not");
});
