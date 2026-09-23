// Extension → MIME type, for the two places that must name a file's type to something outside the
// gateway: the Composio staging request (which requires `mimetype` in the upload request) and the
// public link router's `Content-Type`.
//
// Deliberately a small closed table rather than a dependency. Anything unrecognised is
// `application/octet-stream`, which is the safe answer in both callers: Composio stores the bytes
// either way, and an octet-stream response is the one a browser will not try to render.
const TYPES = new Map(Object.entries({
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/vnd.microsoft.icon",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}));

export const DEFAULT_MIME_TYPE = "application/octet-stream";

export function guessMimeType(name = "") {
  const ext = String(name).toLowerCase().split(".").pop();
  return (ext && TYPES.get(ext)) || DEFAULT_MIME_TYPE;
}
