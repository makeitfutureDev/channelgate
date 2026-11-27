// Route a GPT-Live delegation to one of the call's tools.
//
// GPT-Live (the ChatGPT sign-in voice) has no function tools: everything it cannot answer itself
// arrives as ONE kind of event, a delegation carrying the caller's request. Gemini picks the tool
// itself; here the gateway does, deterministically. The rule is conservative on purpose: only a
// request that is CLEARLY a gateway action (move the call, list conversations, task status, read
// the thread, mark it done, hang up) is handled by the gateway; everything else — including any
// request that mixes navigation with work ("switch to sales and run the report") — goes to the
// channel agent as a task, which is always a safe place for it. English phrasings only; anything
// else reaches the agent as a task, and the dashboard still moves the call by click.

export type DelegationIntent =
  | { kind: "end_call" }
  | { kind: "list"; status: string; channel: string }
  | { kind: "check_tasks" }
  | { kind: "read_thread" }
  | { kind: "mark_done" }
  | { kind: "switch"; target: string; index: number }
  | { kind: "task"; request: string };

const FILLER = /^(?:(?:ok(?:ay)?|so|well|hey|hi|um+|uh+|and|now|then|alright|right|yeah|yes|please|can you|could you|would you|will you|i want you to|i'd like you to|i would like you to|let's|lets)\b[\s,]*)+/;
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5, last: -1 };

export function normalizeUtterance(text: string): string {
  return String(text || "").toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}#' -]+/gu, " ").replace(/\s+/g, " ").trim();
}
function stripFiller(text: string): string {
  let out = text, previous = "";
  while (out !== previous) { previous = out; out = out.replace(FILLER, "").replace(/\s+please$/, "").trim(); }
  return out;
}
// More than one sentence (or "and then …") is a compound request: never split it here.
function isCompound(raw: string): boolean {
  const sentences = String(raw || "").split(/[.!?;]+/).map((s) => stripFiller(normalizeUtterance(s))).filter(Boolean);
  return sentences.length > 1 || /\b(?:and then|and also|after that|then)\b/i.test(sentences.join(" "));
}

const END = /^(?:hang up|end (?:the|this|our) call|stop the call|close the call|goodbye|good bye|bye(?: bye)?|that's all(?: for now)?|that is all(?: for now)?|we're done|we are done|i'm done|i am done)(?: now| thanks| thank you| for now)?$/;
const STATUS = [
  /^(?:is|are) (?:it|they|that|the (?:task|tasks|job|request|agent)|my (?:task|tasks|request)) (?:done|finished|ready|complete|working)(?: yet)?$/,
  /^(?:what's|what is) (?:the )?(?:status|progress)(?: of (?:the|my|that|those) (?:task|tasks|job|request|work))?$/,
  /^(?:how's|how is|how are) (?:it|that|the (?:task|tasks|job|agent|work)|my (?:task|tasks)) (?:going|doing|coming along)$/,
  /^(?:any|what's the|what is the) (?:news|update|updates|progress)(?: on (?:it|that|the task|my task))?$/,
  /^(?:check|check on) (?:the|my) (?:task|tasks|request|requests)$/,
  /^(?:task|tasks) status$/,
];
const READ = [
  /^(?:read|read me|read out) (?:the |this )?(?:thread|conversation|last message|latest message|messages|answer|reply)$/,
  /^what did (?:the agent|it|they|he|she) (?:say|write|answer|reply)(?: (?:here|in this thread|in the thread))?$/,
  /^what (?:was|has been) (?:said|written) (?:here|in this thread|in the thread|in this conversation)$/,
  /^what's in (?:this|the) (?:thread|conversation)$/,
];
const LIST = /^(?:what am i working on|what (?:is|'s) (?:open|pending|waiting)(?: for me)?|what do i have (?:open|pending)|list (?:my )?(?:conversations|threads)|show (?:me )?(?:my )?(?:conversations|threads)|what are my (?:open )?(?:conversations|threads)|which conversations (?:do i have|are open)|what conversations (?:do i have|are open))(?: in (.+?))?$/;
const DONE = [
  /^(?:mark|set) (?:this|the|that) (?:thread|conversation)(?: as)? (?:done|complete|completed|closed|finished)$/,
  /^(?:close|complete|finish) (?:this|the) (?:thread|conversation)$/,
  /^(?:mark it|this thread is|this conversation is) done$/,
];
const SWITCH = /^(?:switch|move|go|jump|take me|change|bring me|get me)(?: the call| this call| us)? (?:back )?(?:to|over to|into) (.+)$/;
const OPEN = /^open (?:up )?(?:the )?(.+?) (?:thread|conversation|channel)$|^open (?:the )?(?:thread|conversation|channel) (?:about |called |named |for )?(.+)$/;
const ORDINAL_PICK = /^(?:open |pick |choose |take |go to |switch to )?(?:the )?(?:number )?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|one|two|three|four|five|\d)(?: one| conversation| thread)?$/;

function ordinal(word: string): number {
  if (/^\d$/.test(word)) return Number(word);
  return ORDINALS[word] ?? 0;
}
function cleanTarget(target: string): string {
  return target.replace(/^(?:the|my|our)\s+/, "").replace(/\s+(?:one|please|now)$/, "").replace(/^(?:conversation|thread) (?:about|on|for|called|named)\s+/, "").trim();
}

export function routeDelegation(text: string): DelegationIntent {
  const request = String(text || "").trim();
  if (!request) return { kind: "task", request: "" };
  const plain = stripFiller(normalizeUtterance(request));
  if (!plain) return { kind: "task", request };
  if (END.test(plain)) return { kind: "end_call" };
  if (isCompound(request)) return { kind: "task", request };
  if (STATUS.some((re) => re.test(plain))) return { kind: "check_tasks" };
  if (READ.some((re) => re.test(plain))) return { kind: "read_thread" };
  if (DONE.some((re) => re.test(plain))) return { kind: "mark_done" };
  const list = LIST.exec(plain);
  if (list) return { kind: "list", status: /pending|waiting/.test(plain) ? "waiting" : "open", channel: cleanTarget((list[1] || "").replace(/\s+channel$/, "")) };
  const pick = ORDINAL_PICK.exec(plain);
  if (pick && ordinal(pick[1])) return { kind: "switch", target: "", index: ordinal(pick[1]) };
  const move = SWITCH.exec(plain) || OPEN.exec(plain);
  if (move) {
    const target = cleanTarget(move[1] || move[2] || "");
    const words = target.split(" ").filter(Boolean);
    // A long target, or one that goes on with "and …"/"then …", is a sentence with work in it,
    // not a conversation name: let the agent have it.
    if (target && words.length <= 8 && !/\b(?:and|then|so|to do)\b/.test(target)) {
      const numbered = ORDINAL_PICK.exec(target);
      if (numbered && ordinal(numbered[1])) return { kind: "switch", target: "", index: ordinal(numbered[1]) };
      return { kind: "switch", target, index: 0 };
    }
  }
  return { kind: "task", request };
}

// "the sales channel" / "#sales" / "sales" → a channel-name candidate, or "" when the phrase
// clearly names a conversation instead.
export function channelNameFrom(target: string): string {
  const t = String(target || "").trim();
  const hash = /^#([\p{L}\p{N}_-]+)$/u.exec(t);
  if (hash) return hash[1];
  const named = /^([\p{L}\p{N}_ -]+?) channel$/u.exec(t) || /^channel ([\p{L}\p{N}_ -]+)$/u.exec(t);
  return named ? named[1].trim().replace(/\s+/g, "-") : "";
}
