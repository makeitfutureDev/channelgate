// What a voice-call task tells the channel agent, and what the call learns back while it runs.
//
// A spoken request is not a typed one: speech recognition mishears names and numbers, the request
// often leans on what was just said ("yes, Thursday, not Friday"), and the answer is read aloud to
// the caller as well as posted in the thread. The agent therefore receives the request followed by
// a marked note with those facts and the last few spoken exchanges (Hermes's voice-turn note,
// adapted). The note rides the engine input only; the thread shows the request as spoken.

export const VOICE_TASK_EFFORT = "low";
export const VOICE_TASK_SPEEDS = Object.freeze(["normal", "quick"]);
const RECENT_TURNS = 8;
const RECENT_CHARS = 1_500;
const LINE_CHARS = 300;

export interface SpokenLine { who: "caller" | "agent" | string; text: string }

const clean = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// The last spoken exchanges, oldest first, within a character budget (newest kept first).
export function recentSpokenExchange(transcript: SpokenLine[], callerName = "Caller"): string {
  const lines: string[] = [];
  let used = 0;
  for (const row of [...(transcript || [])].reverse().slice(0, RECENT_TURNS)) {
    const text = clean(row?.text, LINE_CHARS);
    if (!text) continue;
    const line = `${row.who === "caller" ? clean(callerName, 60) || "Caller" : "Voice"}: ${text}`;
    if (used + line.length > RECENT_CHARS) break;
    lines.unshift(line); used += line.length + 1;
  }
  return lines.join("\n");
}

export function buildVoiceTaskText({ request, callerName = "the caller", transcript = [] as SpokenLine[], provider = "gemini" }: {
  request: string; callerName?: string; transcript?: SpokenLine[]; provider?: string;
}): string {
  const recent = recentSpokenExchange(transcript, callerName);
  const relayed = provider === "chatgpt"
    ? "The request text is the caller's own words as speech recognition heard them"
    : "The voice assistant wrote the request text from what the caller said";
  return [
    String(request || "").trim(),
    "",
    "[Voice call note — context, not part of the request above.",
    `This request was spoken by ${clean(callerName, 80) || "the caller"} on a live voice call. ${relayed}: names, numbers and identifiers may be misheard, and later words correct earlier ones (use the latest intent). When a misheard name or value would change what an action does, ask before acting instead of guessing.`,
    "Your answer is posted in this thread and read aloud to the caller, who hears only its beginning: start with one plain sentence that states the outcome (no markdown, no lists, no URLs or code in that sentence), then give any detail. Never say an action succeeded before it actually did.",
    ...(recent ? ["Recent spoken exchange, oldest first:", recent] : []),
    "]",
  ].join("\n");
}

// A short, speakable description of what the agent is doing, from one progress event of a run
// ({ kind: "tool_use", name, target } and friends). "" for events that are not work steps.
const TOOL_WORDS: Record<string, string> = {
  Bash: "running a command", Read: "reading a file", Write: "writing a file", Edit: "editing a file", MultiEdit: "editing a file",
  Grep: "searching the code", Glob: "looking for files", WebFetch: "reading a web page", WebSearch: "searching the web",
  Agent: "running a subagent", Task: "running a subagent", TodoWrite: "updating its plan", NotebookEdit: "editing a notebook",
  command_execution: "running a command", file_change: "editing files", web_search: "searching the web", mcp_tool_call: "using a connected tool",
};
const TARGET_SAFE = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebSearch", "Grep", "Glob"]);
export function describeActivity(event: unknown): string {
  const e = event && typeof event === "object" ? event as Record<string, unknown> : {};
  if (e.kind === "thinking") return "thinking";
  if (e.kind !== "tool_use") return "";
  const name = String(e.name || "");
  const target = clean(e.target, 80);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  const what = TOOL_WORDS[name] || (mcp ? `using ${mcp[1].replace(/[-_]+/g, " ")}` : name ? `using ${name.replace(/[_-]+/g, " ")}` : "working");
  // Only harmless targets are named: a file's name or a search. A command line or a URL can carry
  // a secret and is never repeated to the voice.
  return target && TARGET_SAFE.has(name) ? `${what}: ${target}` : what;
}
