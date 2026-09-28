// The ONE Codex telemetry override every gateway-spawned Codex process carries. Codex sends
// anonymous usage and health metrics to OpenAI by default (its `[otel].metrics_exporter` defaults to
// statsig); `analytics.enabled=false` is the documented switch that turns that collection off and
// forces the metrics exporter to none. It must ride `-c` rather than config.toml: turns run with
// `--ignore-user-config`, and the daemon's own host-side spawns (relay refresh, MCP discovery, model
// discovery) never read a channel's config. Claude Code's twin is DISABLE_TELEMETRY in claude.js.
export const CODEX_NO_TELEMETRY = "analytics.enabled=false";

/** `-c analytics.enabled=false`, for the front of any codex argv (a global option). */
export function codexNoTelemetryArgs() {
  return ["-c", CODEX_NO_TELEMETRY];
}
