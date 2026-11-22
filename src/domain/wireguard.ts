/**
 * Minimal X25519 (RFC 7748) implementation used to mint WireGuard peer key pairs inside the Worker.
 * Workers' WebCrypto has no X25519 key agreement, and a BigInt Montgomery ladder keeps the bundle
 * dependency-free; the keys are only generated once per user and inbound.
 */
const FIELD = (1n << 255n) - 19n;
const A24 = 121665n;

function mod(value: bigint): bigint {
  const remainder = value % FIELD;
  return remainder >= 0n ? remainder : remainder + FIELD;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = mod(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = mod(result * factor);
    factor = mod(factor * factor);
    remaining >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] ?? 0);
  return value;
}

function bigIntToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let remaining = mod(value);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function clamped(scalar: Uint8Array): bigint {
  const copy = new Uint8Array(scalar);
  copy[0] = (copy[0] ?? 0) & 248;
  copy[31] = ((copy[31] ?? 0) & 127) | 64;
  return bytesToBigInt(copy);
}

/** X25519 scalar multiplication; the base point (9) yields a public key from a private key. */
function scalarMultiply(privateKey: Uint8Array, point: Uint8Array): Uint8Array {
  const scalar = clamped(privateKey);
  const x1 = mod(bytesToBigInt(point));
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let bit = 254; bit >= 0; bit -= 1) {
    const current = (scalar >> BigInt(bit)) & 1n;
    swap ^= current;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = current;
    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    x3 = mod((da + cb) * (da + cb));
    z3 = mod(x1 * mod((da - cb) * (da - cb)));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + A24 * e));
  }
  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return bigIntToBytes(mod(x2 * power(z2, FIELD - 2n)));
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Derives the WireGuard public key of a base64 private key, matching `wg pubkey`. */
export function wireGuardPublicKey(privateKey: string): string {
  const bytes = base64ToBytes(privateKey.trim());
  if (bytes.length !== 32) throw new Error("WireGuard private keys must decode to 32 bytes.");
  return bytesToBase64(scalarMultiply(bytes, Uint8Array.of(9, ...new Array<number>(31).fill(0))));
}

export function generateWireGuardKeys(): { privateKey: string; publicKey: string } {
  const privateKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  return { privateKey, publicKey: wireGuardPublicKey(privateKey) };
}
