// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Persistent installation capacity, separate from the monthly run ledger. Called only while
// the store holds BEGIN IMMEDIATE, so concurrent registration cannot claim the same last slot.
import { API_PRINCIPAL } from "../config/api-principal.js";
import { getEffectiveLimits } from "./license.js";
import { signupUrl } from "./tiers.js";

export function assertRegistrationCapacity(kind, db) {
  const limit = getEffectiveLimits()[kind];
  if (limit === null) return;
  const used = kind === "users"
    ? Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE user_id != ?").get(API_PRINCIPAL).n)
    : Number(db.prepare("SELECT COUNT(*) AS n FROM channels").get().n);
  if (used < limit) return;
  const description = kind === "channels" ? "registered channels (including DMs and API conversations)" : "registered users";
  const error = new Error(`This ChannelGate install has reached its limit of ${limit} ${description}. Existing records remain available. An Enterprise License removes this limit: ${signupUrl()}.`);
  error.code = "license_registration_limit";
  error.status = error.statusCode = 403;
  error.kind = kind;
  error.limit = limit;
  throw error;
}
