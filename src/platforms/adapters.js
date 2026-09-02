import { slackAdapter } from "./slack.js";
import { googleChatAdapter } from "./googlechat.js";
import { teamsAdapter } from "./msteams.js";

// Order matters only for display. Slack first because it is the GA surface.
export const BUILTIN_PLATFORM_ADAPTERS = Object.freeze([slackAdapter, googleChatAdapter, teamsAdapter]);
