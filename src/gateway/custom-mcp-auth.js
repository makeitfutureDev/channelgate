// Fixed custom MCP authentication schemes, shared by daemon relay and engine configuration.
/** Missing authType is the legacy Bearer format; unknown values must never pick a header. */
export function normalizeCustomMcpAuthType(value = "bearer") {
  if (value !== "bearer" && value !== "composio") throw new Error("Authentication type must be bearer or composio");
  return value;
}

/** The fixed authentication headers supported by custom connections (no arbitrary header names). */
export function customMcpAuthentication(authType) {
  return normalizeCustomMcpAuthType(authType) === "composio"
    ? { headerName: "x-consumer-api-key", prefix: "" }
    : { headerName: "Authorization", prefix: "Bearer " };
}

