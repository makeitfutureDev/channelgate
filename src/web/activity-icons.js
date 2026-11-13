// Recolour the existing, reviewed PNG artwork. Decode only our immutable local RGB/RGBA assets;
// retain dimensions, alpha and anti-aliasing. No uploads, renderer processes or added dependencies.
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { logoColor, logoForeground, DEFAULT_LOGO_COLOR } from "../config/appearance.js";

const files = new Set(["activity-icon-192.png", "activity-icon-512.png", "activity-icon-maskable-512.png"]);
const originals = new Map();
let cachedColor = "", cache = new Map(); // bounded to one palette, never attacker-chosen cache keys
const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
function decode(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), channels = bytes[25] === 6 ? 4 : 3;
  if (bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[28] !== 0) throw new Error("Unexpected Activity icon format");
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error("Unexpected Activity icon filter");
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0;
      pixels[at] = raw[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
    }
  }
  return { width, height, channels, pixels };
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  let crc = 0xffffffff;
  for (const value of out.subarray(4, -4)) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
export function activityIcon(file, requestedColor) {
  if (!files.has(file)) throw new Error("Unknown Activity icon");
  const color = logoColor(requestedColor);
  if (!originals.has(file)) { const bytes = readFileSync(new URL(`../../public/activity/${file}`, import.meta.url)); originals.set(file, { bytes, ...decode(bytes) }); }
  const source = originals.get(file);
  if (color === DEFAULT_LOGO_COLOR) return source.bytes;
  if (cachedColor !== color) { cachedColor = color; cache = new Map(); }
  if (cache.has(file)) return cache.get(file);
  const background = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const foreground = [1, 3, 5].map((i) => parseInt(logoForeground(color).slice(i, i + 2), 16));
  const { width, height, channels, pixels } = source, stride = width * channels, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * channels, dest = y * (stride + 1) + 1 + x * channels;
    // Original art blends orange #ff642f and green #18382b; retain that exact coverage.
    const orange = Math.max(0, Math.min(1, (pixels[at] - 24) / 231));
    for (let c = 0; c < 3; c++) raw[dest + c] = Math.round(background[c] * orange + foreground[c] * (1 - orange));
    if (channels === 4) raw[dest + 3] = pixels[at + 3];
  }
  const ihdr = Buffer.from(source.bytes.subarray(16, 29));
  const output = Buffer.concat([source.bytes.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  cache.set(file, output); return output;
}
