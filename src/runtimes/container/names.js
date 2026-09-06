// Container, volume and label naming — the one home for "what is this channel's container called".
//
// Two gateways can share one host under different users (one bot per Linux account, each
// with its own user systemd unit) and, with a rootful daemon, they would share ONE container namespace. So
// every name carries the install id: sha256 of the runtime root's real path, not the per-boot
// instanceId, so a restart finds its own containers again. Discovery is by NAME and then VERIFIED
// by the `cg.install` label — a container that happens to answer to our name but carries a foreign
// or missing install label is never touched.
import { createHash } from "node:crypto";
import { gatewayRoot, installId, platformFolder } from "../../config/paths.js";

// Container names are clamped to 63 characters (the conservative DNS-label ceiling both CLIs are
// happy with, and what a podman network alias accepts). The HOME volume is the same name plus
// "-home", so the STEM is clamped 5 characters shorter and both stay inside the ceiling.
export const NAME_MAX = 63;
export const HOME_SUFFIX = "-home";
const STEM_MAX = NAME_MAX - HOME_SUFFIX.length;

// installId() realpaths the gateway root on every call and sits on the per-run hot path; memoize
// per root so a test that repoints CHANNELGATE_DIR still gets the right answer.
let cachedInstall = { root: "", id: "" };
export function currentInstallId() {
  const root = gatewayRoot();
  if (cachedInstall.root !== root) cachedInstall = { root, id: installId() };
  return cachedInstall.id;
}

function safeComponent(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

function clamp(name, max) {
  if (name.length <= max) return name;
  // Keep the readable head and make the tail collision-proof: two long slugs that share a prefix
  // must not resolve to the same container.
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, max - digest.length - 1)}-${digest}`;
}

export function containerName({ slug, platform } = {}) {
  const stem = `cg-${currentInstallId()}-${safeComponent(platformFolder(platform))}-${safeComponent(slug) || "unknown"}`;
  return clamp(stem, STEM_MAX);
}

export function homeVolumeName(target) {
  return `${containerName(target)}${HOME_SUFFIX}`;
}

// The label set every container we create carries. `channelgate=1` is the coarse marker an
// operator can filter on; `cg.install` is the ownership proof; `cg.fingerprint` is what a later
// run compares to decide "reuse or recreate" (§7).
//
// `cg.mounts` is the MOUNT-ONLY half of that fingerprint, carried separately because the two kinds
// of mismatch are not equally urgent: a new image id can wait for the container to go idle, while a
// changed workspace/artifact path means the running container is bound to directories that may no
// longer exist. Only a mismatch of the FULL fingerprint ever makes us read this one, so a container
// created before the label existed is untouched until something actually changes — and an empty
// value then reads as "unknown", which the lifecycle treats as mount-affecting (fail closed).
export const LABEL_MARKER = "channelgate";
export const LABEL_INSTALL = "cg.install";
export const LABEL_PLATFORM = "cg.platform";
export const LABEL_CHANNEL = "cg.channel";
export const LABEL_FINGERPRINT = "cg.fingerprint";
export const LABEL_MOUNTS = "cg.mounts";
export const LABEL_IMAGE = "cg.image";
export const LABEL_CREATED = "cg.created";

// `created` is deliberately NOT defaulted to now(): prepareTarget() must be pure, so it asks for
// the label set WITHOUT a timestamp and only the create call stamps one.
export function containerLabels(target, { fingerprint = "", mountFingerprint = "", image = "", created = "" } = {}) {
  const labels = {
    [LABEL_MARKER]: "1",
    [LABEL_INSTALL]: currentInstallId(),
    [LABEL_PLATFORM]: String(target?.platform || ""),
    [LABEL_CHANNEL]: String(target?.slug || ""),
    [LABEL_FINGERPRINT]: String(fingerprint || ""),
    [LABEL_IMAGE]: String(image || ""),
  };
  if (mountFingerprint) labels[LABEL_MOUNTS] = String(mountFingerprint);
  if (created) labels[LABEL_CREATED] = created;
  return labels;
}

export function labelArgs(labels) {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

// The filter every discovery pass uses: OUR install only, never `channelgate=1` alone — the other
// gateway on this host is also a ChannelGate.
export function installFilterArgs() {
  return ["--filter", `label=${LABEL_INSTALL}=${currentInstallId()}`];
}

export function isOurContainer(labels) {
  return String(labels?.[LABEL_INSTALL] || "") === currentInstallId();
}
