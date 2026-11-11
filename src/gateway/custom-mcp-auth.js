// Custom MCP authentication presets; custom request fields are assembled only by the daemon.
/** Missing authType is the legacy Bearer format; unknown values must never pick a header. */
export function normalizeCustomMcpAuthType(value = "bearer") {
  if (value !== "bearer" && value !== "composio" && value !== "custom") throw new Error("Authentication type must be bearer, composio or custom");
  return value;
}

/** Preset authentication header, or no implicit header for custom request fields. */
export function customMcpAuthentication(authType) {
  if (normalizeCustomMcpAuthType(authType) === "custom") return { headerName: null, prefix: "" };
  return authType === "composio"
    ? { headerName: "x-consumer-api-key", prefix: "" }
    : { headerName: "Authorization", prefix: "Bearer " };
}

