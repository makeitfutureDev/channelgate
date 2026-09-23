// What container storage can be reclaimed — decided, never done, here.
//
// Nothing in the gateway reclaims container storage by itself, and that is deliberate: every image
// build keeps the previous runtime image, the idle reaper STOPS a channel's container without
// removing it (restart is sub-second), and a container keeps the image it was created from alive.
// Left alone that fills the host. But removal is an operator's decision, made from a report — never a
// background tidy-up — because the one irreversible mistake (a channel's HOME volume) destroys its
// engine sessions, CLI logins and installed tools. `scripts/runtime-storage.mjs` shows this report and
// removes only with --apply; this module is the pure policy both halves share.
//
// Two facts make a naive cleanup wrong, and every rule below exists because of one of them:
//   * A container's TAG follows `:latest`, so every channel container looks current. Only its image
//     ID says which image it pins.
//   * Rootless podman's store is per OS user, not per gateway. A container named for another install
//     (`cg-<install>-…`) may be a finished test run's leftover — or a second, LIVE gateway under the
//     same account. The difference is on disk: a dead install's bind-mounted folders are gone (a test
//     run's scratch root is deleted), a live one's exist. Only the first kind is ever removed.

export const KEEP = "keep";
export const REMOVE = "remove";

const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

function bytes(n) {
  const value = Number(n) || 0;
  return value > 0 ? value : 0;
}

// Newest first by dotted version ("1.10.0" after "1.9.0"); unparseable versions sort last.
function compareSpecDesc(a, b) {
  const pa = String(a || "").split(".").map((x) => Number(x));
  const pb = String(b || "").split(".").map((x) => Number(x));
  if (pa.some(Number.isNaN)) return 1;
  if (pb.some(Number.isNaN)) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * @param {object} input
 * @param {Array<{id,name,running,imageId,install,labeled,mounts:Array<{type,source,volume}>}>} input.containers
 * @param {Array<{id,tags:string[],size,spec}>} input.images
 * @param {Array<{name}>} input.volumes
 * @param {string} input.installId       this gateway's install id (`cg-<id>-…` names)
 * @param {string} input.currentImageId  the image `:latest` of the runtime repository resolves to
 * @param {string} input.runtimeRepo     e.g. "channelgate/runtime"
 * @param {number} [input.keepPreviousSpecs=1] older spec versions kept for rollback
 * @param {(path:string)=>boolean} input.sourceExists  does a bind-mount source exist on the host
 */
export function classifyStorage({ containers = [], images = [], volumes = [], installId, currentImageId = "", runtimeRepo = "channelgate/runtime", keepPreviousSpecs = 1, sourceExists = () => true }) {
  const sameId = (a, b) => Boolean(a && b) && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));

  // ── Containers ──────────────────────────────────────────────────────────────────────────────
  const orphanedInstalls = new Set();
  const containerRows = containers.filter((c) => c.labeled).map((c) => {
    const own = c.install === installId;
    const row = { ...c, own };
    if (own) {
      if (c.running) return { ...row, action: KEEP, reason: "running — may hold a lease for a turn, a job, a schedule or an editor" };
      if (currentImageId && !sameId(c.imageId, currentImageId)) {
        return { ...row, action: REMOVE, reason: "stopped, and created from a superseded image — it is recreated on the current image the next time its channel is used; its HOME volume is kept" };
      }
      return { ...row, action: KEEP, reason: "stopped on the current image — restarts in under a second" };
    }
    const binds = (c.mounts || []).filter((m) => m.type === "bind" && m.source);
    const dead = binds.filter((m) => !sourceExists(m.source));
    if (binds.length && dead.length === binds.length) {
      orphanedInstalls.add(c.install);
      return { ...row, action: REMOVE, reason: `another install (${c.install}) whose mounted folders no longer exist — a finished test run's leftover, nothing can use it${c.running ? " (still running `sleep infinity`)" : ""}` };
    }
    return { ...row, action: KEEP, reason: `another install (${c.install}) whose folders still exist — possibly a second live gateway under this account; never touched` };
  });

  // ── Images ──────────────────────────────────────────────────────────────────────────────────
  const keptContainers = containerRows.filter((c) => c.action === KEEP);
  const refs = (id) => keptContainers.filter((c) => sameId(c.imageId, id)).length;
  const repoMatch = (tag) => tag.replace(/^localhost\//, "").split(":")[0] === runtimeRepo;
  const runtimeImages = images.filter((i) => (i.tags || []).some(repoMatch));
  const previousSpecs = [...new Set(runtimeImages.filter((i) => !sameId(i.id, currentImageId) && i.spec).map((i) => i.spec))]
    .sort(compareSpecDesc).slice(0, Math.max(0, keepPreviousSpecs));
  const imageRows = images.map((i) => {
    const runtime = runtimeImages.includes(i);
    const dangling = !(i.tags || []).length;
    const used = refs(i.id);
    const row = { ...i, runtime, dangling, containers: used };
    if (used) return { ...row, action: KEEP, reason: `still used by ${used} container(s) that stay` };
    if (runtime && sameId(i.id, currentImageId)) return { ...row, action: KEEP, reason: "the current runtime image" };
    if (runtime && previousSpecs.includes(i.spec)) return { ...row, action: KEEP, reason: `spec ${i.spec}, kept as the rollback image` };
    if (runtime) return { ...row, action: REMOVE, reason: `an older runtime image (spec ${i.spec || "unknown"}) no remaining container uses` };
    if (dangling) return { ...row, action: REMOVE, reason: "an untagged, unused image (a leftover build layer)" };
    return { ...row, action: KEEP, reason: "not a ChannelGate runtime image — outside this report's scope" };
  });

  // ── Volumes ─────────────────────────────────────────────────────────────────────────────────
  const volumeUsers = new Map();
  for (const c of containerRows) for (const m of c.mounts || []) if (m.type === "volume" && m.volume) {
    if (!volumeUsers.has(m.volume)) volumeUsers.set(m.volume, []);
    volumeUsers.get(m.volume).push(c);
  }
  const volumeRows = volumes.map((v) => {
    const users = volumeUsers.get(v.name) || [];
    const kept = users.filter((c) => c.action === KEEP);
    const row = { ...v, containers: users.length };
    if (kept.length) return { ...row, action: KEEP, reason: `attached to ${kept.length} container(s) that stay` };
    const match = /^cg-([0-9a-f]+)-/.exec(v.name);
    if (match && match[1] === installId) {
      // Even with its container gone, this is a channel's engine sessions, CLI logins and tools.
      return { ...row, action: KEEP, reason: "this gateway's channel HOME — never removed by this tool (delete it by hand only for a channel that is gone for good)" };
    }
    if (match && orphanedInstalls.has(match[1])) return { ...row, action: REMOVE, reason: `belongs to install ${match[1]}, whose folders no longer exist` };
    if (match) return { ...row, action: KEEP, reason: `belongs to install ${match[1]} — cannot tell whether that gateway is gone` };
    if (ANONYMOUS_VOLUME.test(v.name) && !users.length) return { ...row, action: REMOVE, reason: "an anonymous volume no container uses" };
    return { ...row, action: KEEP, reason: "not a ChannelGate volume — outside this report's scope" };
  });

  const removable = {
    containers: containerRows.filter((c) => c.action === REMOVE),
    images: imageRows.filter((i) => i.action === REMOVE),
    volumes: volumeRows.filter((v) => v.action === REMOVE),
  };
  return {
    containers: containerRows,
    images: imageRows,
    volumes: volumeRows,
    removable,
    ...reclaimableImageSpace(imageRows),
  };
}

// How much disk removing the "remove" images frees. An image's reported size includes every layer
// it shares with others, and old runtime images share most of their layers with each other and with
// the current one — so neither summing sizes (inflated) nor summing podman's per-image "unique" size
// (deflated: layers the removed images share only among themselves count for none of them) is
// right. Layers are content-addressed, so the true figure is the layers that ONLY removed images use.
// Without layer data for every image, fall back to the summed sizes and say it is an upper bound.
export function reclaimableImageSpace(imageRows) {
  const remove = imageRows.filter((i) => i.action === REMOVE);
  const exact = imageRows.every((i) => Array.isArray(i.layers));
  if (!exact) return { reclaimableImageBytes: remove.reduce((sum, i) => sum + bytes(i.size), 0), reclaimableImagePrecision: "upper-bound" };
  const kept = new Set(imageRows.filter((i) => i.action !== REMOVE).flatMap((i) => i.layers.map((l) => l.digest)));
  const freed = new Map();
  for (const i of remove) for (const l of i.layers) if (!kept.has(l.digest)) freed.set(l.digest, bytes(l.size));
  return { reclaimableImageBytes: [...freed.values()].reduce((a, b) => a + b, 0), reclaimableImagePrecision: "exact" };
}
