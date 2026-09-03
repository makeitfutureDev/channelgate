// Rolling tail buffer: append `chunk` to `buf` but retain only the last `max` characters. Used to
// cap the stdout/stderr kept around for error context, so a chatty or looping child can't grow the
// daemon's memory without bound over a long run.
export function appendTail(buf, chunk, max) {
  const s = buf + chunk;
  return s.length > max ? s.slice(s.length - max) : s;
}
