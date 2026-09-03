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
} = {}) {
  const built = String(builtSpecVersion || "").trim();
  const expected = String(expectedSpecVersion || "").trim();
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
    const result = await cli.runWith(caps, ["image", "inspect", "--format", '{{.Id}}|{{index .Config.Labels "cg.image.version"}}', ref], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      const stderr = String(result.stderr || "").trim();
      // "image not known" (podman) / "No such image" (docker) is ABSENCE; anything else is a real
      // failure the operator has to see verbatim.
      const absent = /image not known|no such image|not found/i.test(stderr) || !stderr;
      return { ref, id: "", version: "", present: false, reason: absent ? imageNotBuiltMessage(ref) : stderr };
    }
    const [id, version] = String(result.stdout || "").trim().split("|");
    return { ref, id: cleanField(id), version: cleanField(version), present: Boolean(cleanField(id)), reason: "" };
  }

  return {
    async inspect(caps, settings, { force = false } = {}) {
      const ref = String(settings?.image || "").trim();
      if (!ref) return { ref: "", id: "", version: "", present: false, reason: "no container image is configured" };
      if (!force && cache && cache.ref === ref && now() - cache.at < ttlMs) return cache.info;
      const info = await inspectOnce(caps, ref);
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
