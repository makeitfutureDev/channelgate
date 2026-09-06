import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Image resolution. The configured ref (`channelgate/runtime:latest` by default) is a MOVING
// pointer: the fingerprint that decides "reuse this container or recreate it" must therefore be
// built from the resolved image ID, not the tag — otherwise `npm run build:image` would leave every
// channel running yesterday's image until someone noticed.
//
// The image is never built inside a turn. A missing image fails the run closed with the one
// command that fixes it, because building takes minutes and would look like a hung answer.
const NO_VALUE = "<no value>";

// The image reference a fresh install runs. `npm run build:image` produces exactly this tag (plus
// the spec-version tag beside it), and src/config/settings.js re-exports this as the default for
// the admin UI's *Image reference* setting — one home, so the updater can name the same image the
// daemon would without importing the settings/database layer.
export const CONTAINER_DEFAULT_IMAGE = "channelgate/runtime:latest";

// Everything in the checkout that the built image is made of. A change under `containers/` is the
// Containerfile, the container-side helper scripts, or the pinned CLI versions — all of which are
// baked in at build time, so the running image is stale the moment one of them moves. The in-image
// BUNDLE (the helper closure scripts/build-image.mjs stages) is deliberately NOT enumerated here:
// its contract is what `imageSpecVersion` exists to version, and versions.json says to bump it when
// the image gains or moves something the daemon relies on. The version comparison below is how a
// bundle change asks for a rebuild.
export const IMAGE_SOURCE_PREFIX = "containers/";

// Read from disk on each explicit check: an updater imports this module before moving the checkout.
export function expectedImageBuild(repoRoot = fileURLToPath(new URL("../../../", import.meta.url))) {
  const directory = path.join(repoRoot, "containers");
  const versions = JSON.parse(readFileSync(path.join(directory, "versions.json"), "utf8"));
  const hash = createHash("sha256");
  function visit(relative = "") {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) hash.update(name).update("\0").update(readFileSync(path.join(directory, name))).update("\0");
    }
  }
  visit();
  return { version: String(versions.imageSpecVersion || ""), digest: hash.digest("hex"), toolchain: versions.npm || {} };
}

export const IMAGE_INSPECT_FORMAT = '{{.Id}}|{{index .Config.Labels "cg.image.version"}}|{{index .Config.Labels "cg.image.digest"}}|{{index .Config.Labels "cg.image.toolchain"}}';
export function parseImageBuild(stdout) {
  const [id, version, digest, toolchain] = String(stdout || "").trim().split("|");
  let pins = {};
  try { pins = JSON.parse(cleanField(toolchain)); } catch { /* older images have no pins label */ }
  return { id: cleanField(id), version: cleanField(version), digest: cleanField(digest), toolchain: pins };
}

export function imageNotBuiltMessage(ref) {
  return `container image ${ref} is not built — run \`npm run build:image\` on the gateway host`;
}

/**
 * Must `npm run build:image` run as part of this update? Pure, so the decision is testable without
 * a container CLI, a checkout, or a build.
 *
 * Nothing rebuilt the channel image on update before this: `containers/` could change, or the spec
 * version could be bumped, and every container channel kept running the OLD image until an operator
 * noticed the boot warning. The build takes minutes, so it is not free — the three conditions below
 * are the ones where the running image is provably not what this checkout expects.
 *
 * @param {object}   input
 * @param {string[]} input.changedPaths             `git diff --name-only <old>..<new>`, repo-relative
 * @param {string}   input.builtSpecVersion         the built image's `cg.image.version` label ("" = none built)
 * @param {string}   input.expectedSpecVersion      `containers/versions.json` in the CANDIDATE checkout
 * @returns {boolean}
 */
export function needsImageBuild({
  changedPaths = [],
  builtSpecVersion = "",
  expectedSpecVersion = "",
  builtDigest = "",
  expectedDigest = "",
} = {}) {
  const built = String(builtSpecVersion || "").trim();
  const expected = String(expectedSpecVersion || "").trim();
  if (expectedDigest && builtDigest !== expectedDigest) return true;
  if (!built) return true; // nothing built (or the label is unreadable) — build it
  if (!expected) return false; // the candidate declares no spec: nothing to compare, leave the image alone
  if (built !== expected) return true;
  return (Array.isArray(changedPaths) ? changedPaths : []).some(isImageSourcePath);
}

// Repo-relative, forward-slashed (what `git diff --name-only` emits on every platform).
export function isImageSourcePath(file) {
  return String(file || "").replaceAll("\\", "/").startsWith(IMAGE_SOURCE_PREFIX);
}

function cleanField(value) {
  const text = String(value || "").trim();
  return text === NO_VALUE ? "" : text;
}

export function createContainerImage({ cli, now = () => Date.now(), ttlMs = 60_000 } = {}) {
  let cache = null; // { ref, at, info }

  async function inspectOnce(caps, ref) {
    const result = await cli.runWith(caps, ["image", "inspect", "--format", IMAGE_INSPECT_FORMAT, ref], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      const stderr = String(result.stderr || "").trim();
      // "image not known" (podman) / "No such image" (docker) is ABSENCE; anything else is a real
      // failure the operator has to see verbatim.
      const absent = /image not known|no such image|not found/i.test(stderr) || !stderr;
      return { ref, id: "", version: "", present: false, reason: absent ? imageNotBuiltMessage(ref) : stderr };
    }
    const built = parseImageBuild(result.stdout);
    return { ref, ...built, present: Boolean(built.id), reason: "" };
  }

  return {
    async inspect(caps, settings, { force = false } = {}) {
      const ref = String(settings?.image || "").trim();
      if (!ref) return { ref: "", id: "", version: "", present: false, reason: "no container image is configured" };
      if (!force && cache && cache.ref === ref && now() - cache.at < ttlMs) return cache.info;
      const info = await inspectOnce(caps, ref);
      const desired = expectedImageBuild();
      Object.assign(info, {
        desiredVersion: desired.version, desiredDigest: desired.digest, desiredToolchain: desired.toolchain,
        managed: ref === CONTAINER_DEFAULT_IMAGE,
        needsRebuild: needsImageBuild({ builtSpecVersion: info.version, expectedSpecVersion: desired.version, builtDigest: info.digest, expectedDigest: desired.digest }),
      });
      cache = { ref, at: now(), info };
      return info;
    },

    invalidate() {
      cache = null;
    },

    peek() {
      return cache?.info || null;
    },
  };
}
