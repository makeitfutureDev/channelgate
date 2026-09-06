// Same-origin API client for the no-build admin application.
export async function api(url, options = {}) {
  // X-CG-Request is the CSRF marker: only same-origin script can set a custom header.
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", "X-CG-Request": "1", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Keep the status and the server's code on the error: a caller that can offer a real remedy
    // (the Host/Origin guard is the one refusal the operator can act on) must be able to tell
    // this failure apart from a generic one, and prose matching would break on a reworded message.
    const error = new Error(body.error || `${res.status}`);
    error.status = res.status;
    if (body.code) error.code = body.code;
    // The parsed body too: a refusal can carry state the caller needs to recover with (a 409 on
    // Settings returns the current settings so the page can repaint instead of guessing).
    error.body = body;
    throw error;
  }
  return body;
}
