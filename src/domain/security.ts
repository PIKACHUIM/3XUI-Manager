const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function verifySecret(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

/** Workers WebCrypto rejects PBKDF2 iteration counts above 100000, so stay at that ceiling. */
const PBKDF2_ROUNDS = 100_000;
const PBKDF2_MIN_ROUNDS = 10_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" }, material, 256);
  return `pbkdf2-sha256$${PBKDF2_ROUNDS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, roundsText, saltText, digestText] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !roundsText || !saltText || !digestText) return false;
  const rounds = Number(roundsText);
  if (!Number.isInteger(rounds) || rounds < PBKDF2_MIN_ROUNDS || rounds > PBKDF2_ROUNDS) return false;
  const salt = base64UrlToBytes(saltText);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: Uint8Array.from(salt).buffer as ArrayBuffer, iterations: rounds, hash: "SHA-256" }, material, 256);
  return verifySecret(bytesToBase64Url(new Uint8Array(bits)), digestText);
}

export async function encryptSecret(value: string, masterKey: string): Promise<string> {
  if (masterKey.length < 32) throw new Error("APP_ENCRYPTION_KEY must contain at least 32 characters.");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(masterKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, masterKey: string): Promise<string> {
  const [ivText, bodyText] = value.split(".");
  if (!ivText || !bodyText) throw new Error("Encrypted value is malformed.");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(masterKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(base64UrlToBytes(ivText)).buffer as ArrayBuffer }, key, Uint8Array.from(base64UrlToBytes(bodyText)).buffer as ArrayBuffer);
  return new TextDecoder().decode(decrypted);
}
