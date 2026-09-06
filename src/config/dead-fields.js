// Fields a stored record may still carry from a RETIRED integration.
//
// A dead field is worse than a useless one when the record is a config blob that listing endpoints
// spread wholesale: nothing reads it, so nothing masks it either, and it rides out of the API in
// cleartext next to the fields that ARE masked. That is exactly what happened to `skillsToken` —
// the Skills Manager MCP token, replaced by the local skills catalog — which stayed in the
// `channel_meta` and `users` JSON blobs after the last reader was deleted and was handed back by
// `GET /api/channels`.
//
// Two defences, because either one alone rots. Migration 20 removes these fields from the rows
// that already exist, and every write goes through stripDeadFields() so a record read before the
// upgrade, or imported from a pre-SQLite JSON tree, cannot put one back.
//
// Removing an integration means adding its secret field here in the same change.
export const DEAD_RECORD_FIELDS = Object.freeze([
  // Skills Manager MCP token (channel meta and user records). Retired with that integration.
  "skillsToken",
]);

// Returns the record without any dead field. The same object is returned untouched when there is
// nothing to strip, so this is free on the hot write path.
export function stripDeadFields(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  if (!DEAD_RECORD_FIELDS.some((field) => Object.hasOwn(record, field))) return record;
  const out = { ...record };
  for (const field of DEAD_RECORD_FIELDS) delete out[field];
  return out;
}
