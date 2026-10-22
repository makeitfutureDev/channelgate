// A sudo schedule is an explicit request, not authority stored in channel metadata. Re-read the
// task and its owner's current rank at the spawn boundary; neither an ordinary schedule nor a
// caller naming another schedule may borrow its host privileges.
import { getSchedules } from "../config/schedules.js";
import { isAdmin } from "../config/store.js";

export async function authorizedSudoSchedule({ id, channelId, authorId, origin, untrustedPrincipal = false } = {}) {
  if (!id || origin !== "schedule" || untrustedPrincipal || !authorId) return false;
  const schedule = getSchedules().find((row) => row.id === id);
  return Boolean(schedule?.enabled && schedule.sudo === true && schedule.kind !== "reminder" && !schedule.loop &&
    schedule.channelId === channelId && schedule.createdBy === authorId && await isAdmin(authorId));
}
