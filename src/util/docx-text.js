// Read-only plain-text extraction from a .docx for file previews. A .docx is a ZIP package; only
// word/document.xml is read. Every size is bounded before inflating (a hostile workspace file can
// be a zip bomb), ZIP64/encrypted/multi-disk packages are refused, and nothing is ever written
// back — the text loses formatting by design, so it is a preview, never an editing source.
import { inflateRawSync } from 'node:zlib';

export const DOCX_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DOCX_MAX_XML_BYTES = 8 * 1024 * 1024;
const ENTRY = 'word/document.xml';

function findEntry(buffer, name) {
  const floor = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= floor; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP package.');
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw new Error('Multi-disk packages are not supported.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 packages are not supported.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP directory.');
    const nameLen = buffer.readUInt16LE(offset + 28);
    const entryName = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (entryName === name) {
      return { flags: buffer.readUInt16LE(offset + 8), method: buffer.readUInt16LE(offset + 10),
        compressed: buffer.readUInt32LE(offset + 20), size: buffer.readUInt32LE(offset + 24), local: buffer.readUInt32LE(offset + 42) };
    }
    offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return null;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = value => value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (match, dec, hex, named) => {
  if (named) return ENTITIES[named.toLowerCase()];
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : match;
});

// Paragraphs become lines; tabs and breaks keep their spacing. Everything else (styles, tables'
// grid, images, fields' instructions) is dropped.
export function documentXmlText(xml) {
  let out = '';
  // Paragraph properties hold tab-stop definitions (<w:tabs><w:tab …/></w:tabs>), not tab characters.
  const body = xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, '');
  for (const [token, run] of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g)) {
    if (run !== undefined) out += decode(run);
    else if (token.startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function docxText(buffer) {
  if (buffer.length > DOCX_MAX_FILE_BYTES) throw new Error('Document is too large to preview.');
  const entry = findEntry(buffer, ENTRY);
  if (!entry) throw new Error('No document body found.');
  if (entry.flags & 1) throw new Error('Encrypted documents cannot be previewed.');
  if (entry.size > DOCX_MAX_XML_BYTES) throw new Error('Document is too large to preview.');
  const at = entry.local;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw new Error('Corrupt ZIP entry.');
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  if (start + entry.compressed > buffer.length) throw new Error('Corrupt ZIP entry.');
  const data = buffer.subarray(start, start + entry.compressed);
  let xml;
  if (entry.method === 0) xml = data;
  else if (entry.method === 8) xml = inflateRawSync(data, { maxOutputLength: DOCX_MAX_XML_BYTES });
  else throw new Error('Unsupported ZIP compression.');
  return documentXmlText(xml.toString('utf8'));
}
