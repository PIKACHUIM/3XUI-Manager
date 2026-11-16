const encoder = new TextEncoder();

function pemDer(value: string, kind: "PRIVATE KEY" | "RSA PRIVATE KEY" | "PUBLIC KEY" | "RSA PUBLIC KEY"): Uint8Array {
  const normalized = value.trim().replaceAll("\\n", "\n");
  const body = normalized.replace(new RegExp(`-----BEGIN ${kind}-----|-----END ${kind}-----`, "g"), "").replace(/\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(value.length), ...value]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function privateKeyDer(pem: string): Uint8Array {
  if (pem.includes("BEGIN PRIVATE KEY")) return pemDer(pem, "PRIVATE KEY");
  const rsa = pemDer(pem, "RSA PRIVATE KEY");
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), algorithm, der(0x04, rsa)));
}

function publicKeyDer(pem: string): Uint8Array {
  if (pem.includes("BEGIN PUBLIC KEY")) return pemDer(pem, "PUBLIC KEY");
  const rsa = pemDer(pem, "RSA PUBLIC KEY");
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, concat(algorithm, der(0x03, concat(Uint8Array.of(0), rsa))));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export async function signRsaSha256(payload: string, pem: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", asArrayBuffer(privateKeyDer(pem)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(payload))));
}

export async function verifyRsaSha256(payload: string, signature: string, pem: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", asArrayBuffer(publicKeyDer(pem)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, asArrayBuffer(fromBase64(signature)), encoder.encode(payload));
  } catch {
    return false;
  }
}

export interface StandardWebhookSignature {
  id: string;
  timestamp: string;
  signature: string;
}

export async function verifyHmacSha256(payload: string, signatureHeader: StandardWebhookSignature, secret: string): Promise<boolean> {
  const timestampNumber = Number.parseInt(signatureHeader.timestamp, 10);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;
  const signed = `${signatureHeader.id}.${signatureHeader.timestamp}.${payload}`;
  let keyBytes: Uint8Array;
  try {
    const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    keyBytes = fromBase64(encoded);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed)));
  const expectedBase64 = toBase64(expected);
  return signatureHeader.signature.split(/\s+/).some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value || value.length !== expectedBase64.length) return false;
    let difference = 0;
    for (let index = 0; index < value.length; index += 1) difference |= value.charCodeAt(index) ^ expectedBase64.charCodeAt(index);
    return difference === 0;
  });
}

const md5Shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const md5Constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

export function md5Hex(input: string): string {
  const bytes = encoder.encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let wordIndex: number;
      if (index < 16) { f = (b & c) | (~b & d); wordIndex = index; }
      else if (index < 32) { f = (d & b) | (~d & c); wordIndex = (5 * index + 1) % 16; }
      else if (index < 48) { f = b ^ c ^ d; wordIndex = (3 * index + 5) % 16; }
      else { f = c ^ (b | ~d); wordIndex = (7 * index) % 16; }
      const round = index >>> 4;
      const shift = md5Shifts[round * 4 + (index % 4)]!;
      const next = (a + f + md5Constants[index]! + words[wordIndex]!) | 0;
      const rotated = (next << shift) | (next >>> (32 - shift));
      const priorD = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
      a = priorD;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].map((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

export function verifyEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
