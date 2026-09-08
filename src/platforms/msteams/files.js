// Opt-in Graph file resolution. A valid Teams activity is not permission to read an arbitrary
// tenant drive: resolve metadata, verify the explicit drive allowlist, then fetch bytes WITHOUT
// the Graph bearer. Nothing is fetched until the authorized ingestion path invokes download().
import { ATTACHMENT_MAX_BYTES, readBoundedBytes, oversizeMessage } from '../../util/bounded-bytes.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ID = /^[A-Za-z0-9!_-]{1,512}$/;
const SHARE_HOST = /^[a-z0-9][a-z0-9-]*\.sharepoint\.com$/i;
const DOWNLOAD_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?(?:sharepoint\.com|1drv\.com|storage\.live\.com)$/i;

function safeUrl(raw, host) {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && host.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function descriptorPath(descriptor, drives) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  const keys = Object.keys(descriptor);
  if (keys.length === 1 && keys[0] === 'contentUrl') {
    const url = safeUrl(descriptor.contentUrl, SHARE_HOST);
    return url ? { url } : null;
  }
  if (keys.length === 2 && keys.includes('driveId') && keys.includes('itemId') && typeof descriptor.driveId === 'string' && typeof descriptor.itemId === 'string' && ID.test(descriptor.driveId) && ID.test(descriptor.itemId) && drives.has(descriptor.driveId)) {
    return { route: `/drives/${encodeURIComponent(descriptor.driveId)}/items/${encodeURIComponent(descriptor.itemId)}` };
  }
  return null;
}

function tooLarge(actual, max) { return Object.assign(new Error(`downloaded file ${oversizeMessage(actual, max)}`), { code: 'ETOOLARGE' }); }

export function createTeamsFileResolver({ auth, allowedDriveIds = [], fetchImpl = fetch, maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  if (typeof auth?.token !== 'function') throw new TypeError('Teams file resolution requires Graph authentication');
  if (!Array.isArray(allowedDriveIds) || allowedDriveIds.length > 32 || allowedDriveIds.some((id) => typeof id !== 'string' || !ID.test(id))) throw new TypeError('Teams file drive allowlist is invalid');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ATTACHMENT_MAX_BYTES) throw new TypeError('Teams file byte limit is invalid');
  const drives = new Set(allowedDriveIds);
  return function resolveFile(descriptor) {
    if (!drives.size) return null;
    const reference = descriptorPath(descriptor, drives);
    if (!reference) return null;
    return async function download() {
      const timeout = AbortSignal.timeout(120000);
      const token = await auth.token();
      const metadataAt = async (route, fields) => {
        const metadata = await fetchImpl(`${GRAPH}${route}?$select=${fields}`, {
          method: 'GET', redirect: 'error', signal: timeout,
          headers: { authorization: `Bearer ${token}` },
        });
        if (!metadata.ok) throw new Error(`Teams file metadata is unavailable (${metadata.status}). Check selected-site permissions.`);
        return JSON.parse((await readBoundedBytes(metadata, 128 * 1024)).toString('utf8'));
      };
      let route = reference.route;
      let resolvedDrive = descriptor.driveId;
      if (!route) {
        const target = new URL(reference.url);
        for (const drive of drives) {
          const root = await metadataAt(`/drives/${encodeURIComponent(drive)}/root`, 'id,webUrl');
          const rootUrl = safeUrl(root?.webUrl, SHARE_HOST);
          if (!rootUrl) continue;
          const base = new URL(rootUrl);
          if (base.origin !== target.origin) continue;
          let relative;
          try {
            const prefix = decodeURIComponent(base.pathname).replace(/\/$/, '') + '/';
            const targetPath = decodeURIComponent(target.pathname);
            if (!targetPath.startsWith(prefix)) continue;
            relative = targetPath.slice(prefix.length).split('/');
          } catch { continue; }
          if (!relative.length || relative.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) continue;
          route = `/drives/${encodeURIComponent(drive)}/root:/${relative.map(encodeURIComponent).join('/')}`;
          resolvedDrive = drive;
          break;
        }
        if (!route) throw new Error('Use a canonical SharePoint file link inside an allowed drive, or upload the file directly in a personal chat. Sharing shortlinks are not supported.');
      }
      const item = await metadataAt(route, 'id,name,parentReference,file,size,@microsoft.graph.downloadUrl');
      if (!item || typeof item.id !== 'string' || !ID.test(item.id) || !item.file || !drives.has(item.parentReference?.driveId) || item.parentReference.driveId !== resolvedDrive) throw new Error('Teams file is outside the allowed drives or is not a file.');
      if (descriptor.itemId && (item.id !== descriptor.itemId || item.parentReference.driveId !== descriptor.driveId)) throw new Error('Teams file identity did not match the requested item.');
      if (Number(item.size) > maxBytes) throw tooLarge(Number(item.size), maxBytes);
      const url = safeUrl(item['@microsoft.graph.downloadUrl'], DOWNLOAD_HOST);
      if (!url) throw new Error('Teams file download URL is not an allowed Microsoft file host.');
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: timeout });
      if (!response.ok) throw new Error(`Teams file download failed (${response.status}).`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => {}); throw tooLarge(declared, maxBytes); }
      if (!response.body) throw new Error('Teams file download was empty.');
      let total = 0;
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBytes) throw tooLarge(total, maxBytes);
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: 200, headers: response.headers });
    };
  };
}
