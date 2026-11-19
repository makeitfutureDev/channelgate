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
//
// Custom MCPs additionally honour the operator's approved PRIVATE destinations
// (src/config/private-mcp-hosts.js): createCustomMcpFetch() resolves through resolveCustomMcpUrl,
// which lets one exact admin-approved `host:port` through ONLY when every record it resolves to is a
// private (RFC 1918 / ULA) address, and only there may the request be plain http://.
import { Agent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { resolvePublicHttpUrl } from "../web/security.js";
import { classifyAddress } from "../web/ip-policy.js";
import { PRIVATE_MCP_ADDRESS_CLASS, privateMcpHostKey, readPrivateMcpHosts } from "../config/private-mcp-hosts.js";

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

/**
 * Resolve a custom MCP URL: a public https destination (resolvePublicHttpUrl), or — when its exact
 * `host:port` is on `privateHosts` — an http(s) destination whose EVERY record is a private address.
 * Returns `{ url, addresses, private }`; throws a value-free reason otherwise. `lookup` is for tests.
 */
export async function resolveCustomMcpUrl(value, { lookup, privateHosts = [] } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("must be an http(s) URL");
  const approved = readPrivateMcpHosts(privateHosts).includes(privateMcpHostKey(url));
  if (!approved) {
    if (url.protocol !== "https:") throw new Error("must use https:// unless an admin approved this private host:port");
    return { ...(await resolvePublicHttpUrl(url.href, lookup ? { lookup } : {})), private: false };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let records;
  if (isIP(host)) records = [{ address: host }];
  else {
    const resolve = lookup ?? (await import("node:dns/promises")).lookup;
    try {
      records = await resolve(host, { all: true });
    } catch {
      throw new Error(`could not resolve ${host}`);
    }
  }
  if (!Array.isArray(records) || !records.length) throw new Error(`could not resolve ${host}`);
  for (const { address } of records) {
    const kind = classifyAddress(address);
    if (kind !== PRIVATE_MCP_ADDRESS_CLASS) throw new Error(`${host} resolves to a ${kind || "public"} address, not a private LAN address`);
  }
  return { url, addresses: records.map(({ address }) => ({ address, family: isIP(address) })), private: true };
}

/** A fetch-compatible function; `resolve`, `requestImpl` and `httpRequestImpl` are injectable for tests only. */
export function createPublicPinnedFetch({ resolve = resolvePublicHttpUrl, requestImpl = httpsRequest, httpRequestImpl = httpRequest } = {}) {
  const agent = new Agent({ keepAlive: false });
  const httpAgent = new HttpAgent({ keepAlive: false });
  return async function publicPinnedFetch(input, init = {}) {
    const resolved = await resolve(requestHref(input));
    const { url, addresses } = resolved;
    // Plain http only to a destination the resolver vetted as an approved PRIVATE one.
    const plain = url.protocol === "http:" && resolved.private === true;
    if (url.protocol !== "https:" && !plain) throw new TypeError("remote MCP relay requires an HTTPS URL");
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
      const req = (plain ? httpRequestImpl : requestImpl)(url, { method, headers, lookup, agent: plain ? httpAgent : agent, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
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

/** The custom-MCP fetch: public https, or an approved private host:port. `getPrivateHosts` is read per dial, so a removed approval stops the next request. */
export function createCustomMcpFetch(getPrivateHosts, options = {}) {
  return createPublicPinnedFetch({
    ...options,
    resolve: (href) => resolveCustomMcpUrl(href, { privateHosts: getPrivateHosts() }),
  });
}
