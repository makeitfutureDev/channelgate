// Portable, user-facing descriptions for subprocess completion. Exit values are implementation
// details, not explanations: 0 is universally success, a few shell values have portable meanings,
// and every other non-zero value is application-specific. Keep the raw code/signal in structured
// logs or error.details while surfaces shown to people use these semantic summaries.

import { redactLogValue } from "./redact.js";

const SIGNAL_SUMMARIES = Object.freeze({
  SIGHUP: "stopped because its controlling session ended",
  SIGINT: "was interrupted before it finished",
  SIGQUIT: "was interrupted before it finished",
  SIGILL: "crashed after trying to execute an invalid instruction",
  SIGABRT: "crashed after aborting itself",
  SIGFPE: "crashed during an invalid arithmetic operation",
  SIGKILL: "was forcibly stopped before it finished",
  SIGSEGV: "crashed after an invalid memory access",
  SIGPIPE: "stopped because its output connection closed",
  SIGALRM: "stopped after reaching an internal time limit",
  SIGTERM: "was asked to stop before it finished",
  SIGXCPU: "stopped after reaching its CPU time limit",
  SIGXFSZ: "stopped after trying to create a file that was too large",
});

// Conventional shell translations for signals. These are not treated as raw process codes in the
// UI; they are useful when a shell exits normally after translating a child signal into 128 + N.
const SHELL_EXIT_SUMMARIES = Object.freeze({
  129: SIGNAL_SUMMARIES.SIGHUP,
  130: SIGNAL_SUMMARIES.SIGINT,
  131: SIGNAL_SUMMARIES.SIGQUIT,
  132: SIGNAL_SUMMARIES.SIGILL,
  134: SIGNAL_SUMMARIES.SIGABRT,
  136: SIGNAL_SUMMARIES.SIGFPE,
  137: SIGNAL_SUMMARIES.SIGKILL,
  139: SIGNAL_SUMMARIES.SIGSEGV,
  141: SIGNAL_SUMMARIES.SIGPIPE,
  142: SIGNAL_SUMMARIES.SIGALRM,
  143: SIGNAL_SUMMARIES.SIGTERM,
});

function normalizedCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function spawnErrorCode(error) {
  const direct = typeof error === "object" && error ? String(error.code || "").toUpperCase() : "";
  if (direct) return direct;
  const message = String(error || "").toUpperCase();
  return ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EMFILE", "ENFILE", "ENOMEM"]
    .find((code) => message.includes(code)) || "";
}

// A failing provider answers with a JSON document, and a CLI often hands that document back
// verbatim as its error "message". Two callers need the same unwrapping for opposite reasons: the
// runner needs the fields INSIDE it (the HTTP status, the provider's error type) to classify the
// failure at all, and every surface that shows a person what went wrong needs the sentence rather
// than the document. Returns the parsed object, or null when the text is already prose.
// Deliberately tolerant: the body is often quoted inside a line of prose ("unexpected status 400
// Bad Request: {…}"), so the first `{` through the last `}` is what is parsed.
export function embeddedJsonObject(value) {
  const text = String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The human sentence such a body carries, wherever the provider put it. Providers nest one level
// (`{ error: { message } }`) or none, and name the field `message`, `detail` or `error`; a body
// whose message is ITSELF a quoted body (a CLI wrapping what it received) is unwrapped once more.
function providerSentence(body, depth = 0) {
  if (!body || typeof body !== "object") return "";
  const nested = body.error && typeof body.error === "object" ? body.error : null;
  const candidate = [nested?.message, nested?.detail, body.message, body.detail, body.error]
    .find((value) => typeof value === "string" && value.trim());
  const text = String(candidate || "").trim();
  if (!text) return "";
  if (depth >= 2) return text;
  const inner = embeddedJsonObject(text);
  return (inner && providerSentence(inner, depth + 1)) || text;
}

// One readable line for a person: never a JSON document, never a stack, never unbounded. Used by
// every surface that reports a failed turn — a thread message is read by someone who has to decide
// what to do next, and `{"type":"error","status":400,…}` tells them nothing they can act on.
export function plainFailureText(value, maxChars = 400) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(1, Number(maxChars)) : 400;
  const raw = String(value ?? "").trim();
  const body = embeddedJsonObject(raw);
  const sentence = body ? providerSentence(body) : "";
  // Keep the prose the CLI wrapped around the body ("Codex provider error: {…}") and replace only
  // the document itself, so a message that was already a sentence is returned untouched.
  const prose = sentence ? raw.slice(0, raw.indexOf("{")).trim() : "";
  const text = sentence
    ? `${prose}${prose ? " " : ""}${sentence}`.trim()
    : body
      ? raw.replace(/\{[\s\S]*\}/, "").trim() || "the provider rejected the request"
      : raw;
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function conciseProcessDiagnostic(value, maxChars = 600) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(1, Number(maxChars)) : 600;
  return redactLogValue(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" · ")
    .slice(0, limit);
}

export function describeProcessOutcome({
  code = null,
  signal = "",
  spawnError = null,
  timedOut = false,
  timeout = "",
} = {}) {
  if (spawnError) {
    const errorCode = spawnErrorCode(spawnError);
    const summary = errorCode === "ENOENT"
      ? "couldn't start because its executable was not found"
      : errorCode === "EACCES" || errorCode === "EPERM"
        ? "couldn't start because the operating system denied permission"
        : errorCode === "ENOEXEC"
          ? "couldn't start because its executable format is invalid"
          : errorCode === "EMFILE" || errorCode === "ENFILE"
            ? "couldn't start because the system has too many files open"
            : errorCode === "ENOMEM"
              ? "couldn't start because the system ran out of memory"
              : "couldn't start";
    return { ok: false, kind: "start_failed", summary };
  }

  if (timedOut) {
    const span = String(timeout || "").trim();
    return {
      ok: false,
      kind: "timed_out",
      summary: span
        ? `stopped after reaching the ${span} time limit`
        : "stopped after reaching its time limit",
    };
  }

  const normalizedSignal = String(signal || "").trim().toUpperCase();
  if (normalizedSignal) {
    return {
      ok: false,
      kind: "interrupted",
      summary: SIGNAL_SUMMARIES[normalizedSignal] || "was stopped by the operating system before it finished",
    };
  }

  const exitCode = normalizedCode(code);
  if (exitCode === 0) return { ok: true, kind: "success", summary: "completed successfully" };
  if (SHELL_EXIT_SUMMARIES[exitCode]) {
    return { ok: false, kind: "interrupted", summary: SHELL_EXIT_SUMMARIES[exitCode] };
  }
  if (exitCode === 1) {
    return { ok: false, kind: "failed", summary: "failed because it reported a general error" };
  }
  if (exitCode === 2) {
    return { ok: false, kind: "invalid_input", summary: "failed because it rejected its input or options" };
  }
  if (exitCode === 126) {
    return {
      ok: false,
      kind: "not_executable",
      summary: "couldn't run because the target is not executable or permission was denied",
    };
  }
  if (exitCode === 127) {
    return { ok: false, kind: "not_found", summary: "couldn't run because the command was not found" };
  }
  if (exitCode === null) {
    return {
      ok: null,
      kind: "unknown",
      summary: "stopped before the gateway could confirm whether it succeeded",
    };
  }
  return { ok: false, kind: "failed", summary: "failed before it completed" };
}

export function processFailureMessage(label, options = {}) {
  const subject = String(label || "The process").trim() || "The process";
  const outcome = describeProcessOutcome(options);
  const diagnostic = conciseProcessDiagnostic(options.diagnostic, options.maxDiagnosticChars);
  return `${subject} ${outcome.summary}${diagnostic ? `: ${diagnostic}` : "."}`;
}
