// A fetch for the daemon's remote-MCP relay that only ever reaches PUBLIC addresses — used for the
// custom MCP connections people add themselves (src/gateway/custom-mcps.js). The relay runs in the
// daemon, outside every channel's egress proxy, so a user-supplied URL dialled with the plain
// global fetch would be a way into the host's loopback services (the admin API included), the
// private network and cloud metadata.
//
// Every request — the Streamable HTTP POSTs, the SSE GET, the session DELETE — resolves the host,
// refuses it if ANY record is internal (src/web/security.js), then connects ONLY to the vetted
// records through a pinned `lookup` (no second DNS resolution, so a rebinding answer between the
// check and the connect cannot redirect it). TLS still verifies the certificate against the
// original hostname. Redirects are never followed: a 3xx comes back as-is and the MCP client
// treats it as a failed request, so a public server cannot bounce the relay — and its
// Authorization header — somewhere internal.
//
// The requests use their OWN agent, never the global one: with NODE_USE_ENV_PROXY (or a future
// default) the global agent tunnels through HTTPS_PROXY, and a proxy resolves the host itself —
// which would skip both the pinned lookup and the address check.
import { Agent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { resolvePublicHttpUrl } from "../web/security.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function requestHref(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return String(input?.url || "");
}

function requestBody(body) {
  if (body == null) return null;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError("public MCP fetch supports string or byte request bodies only");
}

/** A fetch-compatible function; `resolve` and `requestImpl` are injectable for tests only. */
export function createPublicPinnedFetch({ resolve = resolvePublicHttpUrl, requestImpl = httpsRequest } = {}) {
  const agent = new Agent({ keepAlive: false });
  return async function publicPinnedFetch(input, init = {}) {
    const { url, addresses } = await resolve(requestHref(input));
    if (url.protocol !== "https:") throw new TypeError("remote MCP relay requires an HTTPS URL");
    if (!Array.isArray(addresses) || !addresses.length) throw new TypeError("refusing to connect without vetted addresses");
    const method = String(init.method || "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = requestBody(init.body);
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return await new Promise((resolvePromise, reject) => {
      const lookup = (_hostname, options, callback) => {
        if (options?.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      };
      const req = requestImpl(url, { method, headers, lookup, agent, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const responseHeaders = new Headers();
        const raw = res.rawHeaders || [];
        for (let i = 0; i + 1 < raw.length; i += 2) responseHeaders.append(raw[i], raw[i + 1]);
        const nullBody = NULL_BODY_STATUSES.has(res.statusCode) || method === "HEAD";
        if (nullBody) res.resume();
        try {
          resolvePromise(new Response(nullBody ? null : Readable.toWeb(res), {
            status: res.statusCode,
            statusText: res.statusMessage || "",
            headers: responseHeaders,
          }));
        } catch (error) {
          res.destroy();
          reject(error);
        }
      });
      req.on("error", reject);
      if (body != null) req.write(body);
      req.end();
    });
  };
}

export const publicPinnedFetch = createPublicPinnedFetch();
