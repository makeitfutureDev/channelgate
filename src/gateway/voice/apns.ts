// APNs token authentication and bounded HTTP/2 transport. No third-party runtime dependency.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

export interface PushConfig {
  enabled: boolean;
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
}
export interface PushDevice { token: string; environment: "sandbox" | "production" }
export interface PushResult { status: number; reason: string }
export function parsePushKey(pem: string): KeyObject {
  if (typeof pem !== "string" || pem.length > 8192 || !pem.includes("BEGIN PRIVATE KEY")) throw new Error("Use an APNs .p8 private key.");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs requires an ES256 (P-256) key.");
  return key;
}
export function pushConfigReady(config: PushConfig): boolean {
  return config.enabled && /^[A-Z0-9]{10}$/.test(config.teamId) && /^[A-Z0-9]{10}$/.test(config.keyId)
    && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.bundleId) && Boolean(config.privateKey);
}
let cached: { key: string; team: string; id: string; issued: number; token: string } | undefined;
export function providerToken(config: PushConfig, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  if (cached && cached.key === config.privateKey && cached.team === config.teamId && cached.id === config.keyId
      && issued >= cached.issued && issued - cached.issued < 1200) return cached.token;
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: issued })).toString("base64url");
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key: parsePushKey(config.privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${input}.${signature}`;
  cached = { key: config.privateKey, team: config.teamId, id: config.keyId, issued, token };
  return token;
}
export function pushHeaders(config: PushConfig, device: PushDevice, id: string): Record<string, string> {
  if (!/^[a-f0-9]{32,512}$/.test(device.token) || device.token.length % 2) throw new Error("Invalid push token.");
  return { ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${providerToken(config)}`,
    "apns-topic": `${config.bundleId}.voip`, "apns-push-type": "voip", "apns-priority": "10", "apns-expiration": "0", "apns-id": id };
}
export async function sendVoipPush(config: PushConfig, device: PushDevice, payload: Record<string, unknown>, id: string, open: (host: string) => ClientHttp2Session = connect): Promise<PushResult> {
  const headers = pushHeaders(config, device, id);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 5120) throw new Error("VoIP payload too large.");
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  return new Promise((resolve, reject) => {
    const client = open(host);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("APNs request timed out.")); }, 8000);
    const fail = () => { clearTimeout(timer); client.destroy(); reject(new Error("APNs connection failed.")); };
    client.on("error", fail);
    const request = client.request(headers);
    let status = 0, response = "";
    request.on("response", h => { status = Number(h[":status"]); });
    request.on("data", (chunk: Buffer) => {
      response += chunk.toString();
      if (response.length > 8192) request.destroy(new Error("APNs response too large."));
    });
    request.on("error", fail);
    request.on("end", () => {
      clearTimeout(timer); client.close();
      let reason = "";
      try { reason = String((JSON.parse(response) as { reason?: string }).reason || ""); } catch { /* status still proves rejection */ }
      resolve({ status, reason });
    });
    request.end(body);
  });
}
