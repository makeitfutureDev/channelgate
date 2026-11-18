// One outbound SSH identity per deployment. Publish the complete keypair by directory rename:
// concurrent container provisioning must never observe half a keypair or rotate an existing one.
import {
  constants, chmodSync, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { configDir } from "./paths.js";

const KEY_TYPE = "ssh-ed25519";
const COMMENT = "channelgate-agent";
const MAGIC = Buffer.from("openssh-key-v1\0");
const SEED_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const invalidIdentity = () => new Error("Deployment agent SSH identity is invalid or unsafe; restore its complete original keypair before retrying.");

export function agentSshDir() {
  return path.join(configDir(), "agent-ssh");
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function string(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function publicBlob(publicBytes) {
  return Buffer.concat([string(KEY_TYPE), string(publicBytes)]);
}

function serializePrivate(privateKey, publicBytes) {
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const check = randomBytes(4);
  const fields = Buffer.concat([
    check, check, string(KEY_TYPE), string(publicBytes),
    string(Buffer.concat([seed, publicBytes])), string(COMMENT),
  ]);
  const padding = Buffer.from(Array.from({ length: 8 - (fields.length % 8) }, (_, index) => index + 1));
  const payload = Buffer.concat([
    MAGIC, string("none"), string("none"), string(""), uint32(1),
    string(publicBlob(publicBytes)), string(Buffer.concat([fields, padding])),
  ]);
  const lines = payload.toString("base64").match(/.{1,70}/g).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

// Parse only the unencrypted Ed25519 format we generate, and prove both files describe the
// seed's actual public key. Key material is never interpolated into diagnostics.
function validatePair(privateText, publicText) {
  try {
    const encoded = privateText.match(/^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)-----END OPENSSH PRIVATE KEY-----\n?$/)?.[1];
    if (!encoded) throw invalidIdentity();
    const bytes = Buffer.from(encoded.replaceAll("\n", ""), "base64");
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw invalidIdentity();
    let offset = MAGIC.length;
    const number = () => {
      if (offset + 4 > bytes.length) throw invalidIdentity();
      const value = bytes.readUInt32BE(offset);
      offset += 4;
      return value;
    };
    const field = () => {
      const length = number();
      if (length > bytes.length - offset) throw invalidIdentity();
      const value = bytes.subarray(offset, offset + length);
      offset += length;
      return value;
    };
    if (field().toString() !== "none" || field().toString() !== "none" || field().length !== 0 || number() !== 1) throw invalidIdentity();
    const outerPublic = field();
    const privateBlock = field();
    if (offset !== bytes.length || privateBlock.length % 8 !== 0) throw invalidIdentity();
    // The same bounded SSH field reader can now consume the embedded private block.
    offset = bytes.length - privateBlock.length;
    if (number() !== number() || field().toString() !== KEY_TYPE) throw invalidIdentity();
    const publicBytes = field();
    const secret = field();
    field(); // comment has no bearing on identity
    const padding = bytes.subarray(offset);
    if (publicBytes.length !== 32 || secret.length !== 64 || !secret.subarray(32).equals(publicBytes)
      || padding.length < 1 || padding.length > 8 || !padding.every((byte, index) => byte === index + 1)) throw invalidIdentity();
    const derived = createPublicKey(createPrivateKey({
      key: Buffer.concat([SEED_DER_PREFIX, secret.subarray(0, 32)]), format: "der", type: "pkcs8",
    })).export({ format: "jwk" });
    if (!Buffer.from(derived.x, "base64url").equals(publicBytes)) throw invalidIdentity();
    const blob = publicBlob(publicBytes);
    const publicFields = publicText.trim().split(/\s+/);
    if (!outerPublic.equals(blob) || publicFields[0] !== KEY_TYPE || publicFields[1] !== blob.toString("base64")) throw invalidIdentity();
    return { publicKey: `${KEY_TYPE} ${blob.toString("base64")} ${COMMENT}`, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
  } catch {
    throw invalidIdentity();
  }
}

function directoryStat(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw invalidIdentity();
  return stat;
}

function readKey(file, mode) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || (stat.mode & 0o7777) !== mode || stat.size > 8192) throw invalidIdentity();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readIdentity(dir) {
  try {
    const before = directoryStat(dir);
    const privateKeyPath = path.join(dir, "id_ed25519");
    const publicKeyPath = path.join(dir, "id_ed25519.pub");
    const pair = validatePair(readKey(privateKeyPath, 0o600), readKey(publicKeyPath, 0o644));
    const after = directoryStat(dir);
    if (before.dev !== after.dev || before.ino !== after.ino) throw invalidIdentity();
    return { ...pair, privateKeyPath, publicKeyPath, dir };
  } catch {
    throw invalidIdentity();
  }
}

function syncDirectory(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function ensureAgentSshIdentity({ dir = agentSshDir() } = {}) {
  dir = path.resolve(dir);
  // Parent symlinks would redirect both provisioning and later mounts to a different store.
  for (let ancestor = path.dirname(dir); ; ancestor = path.dirname(ancestor)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw invalidIdentity();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ancestor === path.dirname(ancestor)) break;
  }
  try {
    lstatSync(dir);
    return readIdentity(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(dir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(path.join(parent, ".agent-ssh-"));
  try {
    chmodSync(temporary, 0o700);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicBytes = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    writeFileSync(path.join(temporary, "id_ed25519"), serializePrivate(privateKey, publicBytes), { mode: 0o600, flag: "wx", flush: true });
    writeFileSync(path.join(temporary, "id_ed25519.pub"), `${KEY_TYPE} ${publicBlob(publicBytes).toString("base64")} ${COMMENT}\n`, { mode: 0o644, flag: "wx", flush: true });
    chmodSync(path.join(temporary, "id_ed25519"), 0o600);
    chmodSync(path.join(temporary, "id_ed25519.pub"), 0o644);
    syncDirectory(temporary);
    try {
      renameSync(temporary, dir);
      syncDirectory(parent);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    }
    return readIdentity(dir);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
