// Admin REST API over the on-disk config store. Edits persist immediately and take effect on
// the next message (the runner re-provisions the folder from meta every time). Tokens are
// returned to the (auth-gated, localhost) admin UI so it can reveal them behind the eye toggle;
// a token is only overwritten on save when a non-empty value is sent (else the stored one stays).
//
// This file is the aggregator: the routes live in one resource module each — settings.js
// (settings/secrets/update/daemon/slack/fs/skills/mcp), observability.js (audit/dashboard/
// active-runs), schedules.js, channels.js (dms + channels + memory + instructions), users.js —
// with shared shape-cleaners in helpers.js. The resource routers are mounted here in the same
// order the routes were originally registered, so every URL, method, and match order is
// unchanged.
import { Router } from "express";
import { startUpdate } from "../../gateway/updater.js";
import { listMakeToolboxTools } from "../../gateway/make-toolbox.js";
import { createSettingsRouter } from "./settings.js";
import { createObservabilityRouter } from "./observability.js";
import { createSchedulesRouter } from "./schedules.js";
import { createChannelsRouter } from "./channels.js";
import { createUsersRouter } from "./users.js";

export function createAdminRouter({
  slack,
  transports = null,
  instanceId = "",
  startGatewayUpdate = startUpdate,
  restartCoordinator,
  testMakeToolbox = listMakeToolboxTools,
} = {}) {
  const router = Router();

  router.use(createSettingsRouter({ slack, transports, instanceId, startGatewayUpdate, restartCoordinator }));
  router.use(createObservabilityRouter());
  router.use(createSchedulesRouter());
  router.use(createChannelsRouter({ slack, testMakeToolbox }));
  router.use(createUsersRouter());

  return router;
}
