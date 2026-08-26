const SECRET_PATTERNS = [
  /\b(xox[baprse]-)[A-Za-z0-9-]+/gi, // incl. xoxe- rotation/refresh tokens
  /\b(sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /([?&](?:token|key|secret|signature)=)[^&\s]+/gi,
  // Composio tokens ride the x-consumer-api-key header and have no recognizable value prefix —
  // redact by name association wherever a header/config object gets stringified into a log.
  /((?:x-consumer-api-key|x-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~-]+/gi,
  /(hooks\.slack\.com\/services\/)[A-Za-z0-9\/]+/gi, // Slack webhook URLs grant post access
  // Bare JWTs: OAuth access/id tokens (the shape every engine credential store holds) carry no
  // prefix and no header name once a CLI echoes one into an error line.
  /\b(eyJ)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
];

export function redactLogValue(value) {
  let text = typeof value === "string" ? value : value instanceof Error ? value.stack || value.message : String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}

export function installConsoleRedaction(target = console) {
  for (const level of ["log", "warn", "error", "info"]) {
    const original = target[level]?.bind(target);
    if (!original) continue;
    target[level] = (...args) => original(...args.map(redactLogValue));
  }
}
