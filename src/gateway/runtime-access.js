// The resolved target is the one source of access facts for both the operating guide and each
// attempt prompt. Never infer mounts from the author role or from a previous conversation turn.
export function containerAccessNote(target) {
  if (!Array.isArray(target?.container?.mounts)) {
    return "**Container access:** no resolved runtime target was supplied at prompt/guide construction. Do not infer host access from the author's role; check the current runtime before claiming a path is mounted or absent.";
  }
  const homes = target.container.mounts.filter((m) => m.kind === "operator-home").map((m) => m.target);
  const setting = target.settings?.fullAccessHome === true ? "on" : "off";
  const access = homes.length
    ? `This channel's resolved runtime includes the operator-home mount at ${homes.map((home) => JSON.stringify(home)).join(", ")}. Every admitted author can read that mounted home; write-capable bypass tools still require an admin author in Admin mode.`
    : "This channel's resolved runtime has no operator-home mount. The working folder, clean workspace and artifacts remain its host directory mounts; the author's admin role alone adds no mount.";
  return `**Container access for this run:** gateway setting \`containerFullAccessHome\` is **${setting}**. ${access} Switching this channel to Admin/Full-access qualifies it for the operator-home mount on the next resolved run ONLY while that gateway switch is on; with the switch off, Admin adds no home mount. The container remains the filesystem/process boundary. \`$HOME\` and \`~\` still refer to the channel's own home volume, not the operator's home. See the \`gateway-usage\` skill's \`references/administration.md\` for the boundary and the optional grant.`;
}

export function runtimeAccessPreamble(target) {
  return "[Gateway container access for THIS attempt]\n"
    + "These current access facts supersede earlier turns and generic claims about host isolation. "
    + "Answer access questions from this resolved runtime, even when the conversation previously said otherwise.\n"
    + containerAccessNote(target) + "\n"
    + "Environment secrets, when injected into a run, are usable by its process and CLI. Write-only means masked listing/reveal surfaces and redacted outputs; it does not mean the process cannot read its environment. Do not print secret values.\n"
    + "[End gateway container access]\n\n";
}
