// Settings controls shared by initial load, save responses and live mode changes.
export function syncComposioPolicyUi(root, { sdkMode, entitled }) {
  root.hidden = !sdkMode;
  for (const input of root.querySelectorAll("input, select, textarea")) input.disabled = !entitled;
  root.querySelector(".csdk-max").disabled = !entitled || !root.querySelector(".csdk-multi").checked;
  root.querySelector(".csdk-app-list").hidden = root.querySelector(".csdk-app-mode").value === "all";
}

export function paintComposioPolicy(root, policy = {}) {
  root.querySelector(".csdk-multi").checked = policy.multiAccount !== false;
  root.querySelector(".csdk-max").value = policy.maxAccountsPerToolkit ?? 5;
  root.querySelector(".csdk-app-mode").value = policy.allowedApps == null ? "all" : "selected";
  root.querySelector(".csdk-apps").value = (policy.allowedApps || []).join(", ");
}

export function readComposioPolicy(root) {
  return {
    multiAccount: root.querySelector(".csdk-multi").checked,
    maxAccountsPerToolkit: Number(root.querySelector(".csdk-max").value),
    allowedApps: root.querySelector(".csdk-app-mode").value === "all" ? null
      : root.querySelector(".csdk-apps").value.split(/[\s,]+/).filter(Boolean),
  };
}
