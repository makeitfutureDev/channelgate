// Canonical Slack attachment recovery. Trigger envelopes are fast notifications, not the source
// of truth: app_mention can omit files and file objects can briefly contain only an id. Hydrate the
// exact message, merge every known file reference, and resolve incomplete hosted files before the
// existing confined downloader runs.

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 120;
const FILE_ID_RE = /^F[A-Z0-9]+$/i;

export function claimSlackMessageTrigger(seen, event) {
  const key = `${event?.channel || ""}:${event?.ts || event?.event_ts || ""}`;
  return Boolean(event?.channel && (event?.ts || event?.event_ts) && seen?.add?.(key));
}

function usable(value) {
  return value !== undefined && value !== null && value !== "";
}

function fileCandidate(value) {
  if (typeof value === "string") return FILE_ID_RE.test(value) ? { id: value } : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = usable(value.id)
    ? String(value.id)
    : usable(value.file_id)
      ? String(value.file_id)
      : "";
  if (!id && !value.url_private && !value.url_private_download) return null;
  return { ...value, ...(id ? { id } : {}) };
}

function candidateKey(file, index) {
  return file.id || file.url_private_download || file.url_private || `${file.name || "file"}:${file.size ?? ""}:${index}`;
}

function mergeDescriptor(current, incoming) {
  if (!current) return { ...incoming };
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (!usable(merged[key]) && usable(value)) merged[key] = value;
  }
  return merged;
}

function pushCandidate(out, value) {
  const candidate = fileCandidate(value);
  if (candidate) out.push(candidate);
}

function collectAttachmentEntries(message, out) {
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    pushCandidate(out, attachment?.file);
    pushCandidate(out, attachment?.file_id);
    for (const file of Array.isArray(attachment?.files) ? attachment.files : []) pushCandidate(out, file);
  }
}

function collectBlockEntries(message, out) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "file") {
      pushCandidate(out, value.file);
      pushCandidate(out, value.file_id);
      pushCandidate(out, value.external_id);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "file" && key !== "file_id" && key !== "external_id") visit(entry);
    }
  };
  visit(message?.blocks);
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    visit(attachment?.blocks);
  }
}

export function collectSlackFiles(message) {
  const candidates = [];
  for (const file of Array.isArray(message?.files) ? message.files : []) pushCandidate(candidates, file);
  pushCandidate(candidates, message?.file);
  for (const id of Array.isArray(message?.x_files) ? message.x_files : []) pushCandidate(candidates, id);
  collectAttachmentEntries(message, candidates);
  collectBlockEntries(message, candidates);

  const byKey = new Map();
  candidates.forEach((candidate, index) => {
    const key = candidateKey(candidate, index);
    byKey.set(key, mergeDescriptor(byKey.get(key), candidate));
  });
  return [...byKey.values()];
}

async function canonicalMessage(event, client) {
  if (!event?.channel || !event?.ts) return null;
  let messages;
  if (event.thread_ts) {
    const response = await client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      oldest: event.ts,
      latest: event.ts,
      inclusive: true,
      limit: 2,
    });
    messages = response?.messages;
  } else {
    const response = await client.conversations.history({
      channel: event.channel,
      oldest: event.ts,
      latest: event.ts,
      inclusive: true,
      limit: 1,
    });
    messages = response?.messages;
  }
  const exact = (Array.isArray(messages) ? messages : []).find(
    (message) => String(message?.ts) === String(event.ts),
  ) || null;
  if (!exact || !event.thread_ts || collectSlackFiles(exact).length) return exact;

  // Slack lets a user upload a file and then @mention the bot in the next thread reply. Recover
  // only when the immediately preceding message carries a file; never reach backward past an
  // intervening text reply and accidentally attach an old file to a later discussion.
  const context = await client.conversations.replies({
    channel: event.channel,
    ts: event.thread_ts,
    latest: event.ts,
    inclusive: true,
    limit: 200,
  });
  const previous = (Array.isArray(context?.messages) ? context.messages : [])
    .filter((message) => Number(message?.ts) < Number(event.ts))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  const previousFiles = collectSlackFiles(previous);
  return previousFiles.length ? { ...exact, files: previousFiles } : exact;
}

function mergeMessage(event, canonical) {
  const merged = canonical
    ? {
        ...event,
        ...canonical,
        channel: event.channel,
        channel_type: event.channel_type,
        user: event.user,
        ts: event.ts,
        thread_ts: event.thread_ts ?? canonical.thread_ts,
      }
    : { ...event };
  const files = [];
  for (const file of collectSlackFiles(event)) files.push(file);
  for (const file of collectSlackFiles(canonical)) files.push(file);

  const byKey = new Map();
  files.forEach((file, index) => {
    const key = candidateKey(file, index);
    byKey.set(key, mergeDescriptor(byKey.get(key), file));
  });
  merged.files = [...byKey.values()];
  return merged;
}

function hasDownloadUrl(file) {
  return Boolean(file?.url_private_download || file?.url_private);
}

async function resolveIncompleteFiles(files, client, logger) {
  const resolved = [];
  for (const candidate of files) {
    if (hasDownloadUrl(candidate) || !candidate.id || !client?.files?.info) {
      resolved.push(candidate);
      continue;
    }
    try {
      const response = await client.files.info({ file: candidate.id });
      resolved.push(mergeDescriptor(candidate, response?.file || {}));
    } catch (error) {
      logger?.warn?.(`[slack] files.info failed for ${candidate.id}: ${error.message}`);
      resolved.push(candidate);
    }
  }
  return resolved;
}

function pendingFiles(files) {
  return files.some((file) => file?.id && !hasDownloadUrl(file));
}

export async function hydrateSlackMessage(event, client, {
  maxAttempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  const attempts = Math.max(1, Math.min(Number(maxAttempts) || DEFAULT_ATTEMPTS, 3));
  let last = mergeMessage(event, null);

  for (let attempt = 0; attempt < attempts; attempt++) {
    let canonical = null;
    try {
      canonical = await canonicalMessage(event, client);
    } catch (error) {
      logger?.warn?.(`[slack] canonical Slack message lookup failed: ${error.message}`);
    }

    last = mergeMessage(last, canonical);
    last.files = await resolveIncompleteFiles(last.files, client, logger);
    const envelopeMayPrecedeFiles =
      attempt === 0 &&
      (event?.type === "app_mention" || event?.subtype === "file_share" || event?.upload === true);
    if ((!pendingFiles(last.files) && !(envelopeMayPrecedeFiles && last.files.length === 0)) || attempt === attempts - 1) {
      return last;
    }
    await sleep(Math.max(0, Number(retryDelayMs) || 0));
  }
  return last;
}
