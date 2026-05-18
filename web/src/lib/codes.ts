// Hashing for the optional 6-character access code on a published spec.
// PBKDF2 via Web Crypto so we have no native deps inside the container.

const ITERATIONS = 200_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

// Unambiguous alphabet: digits + uppercase, minus 0/O/1/I.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateCode(length = 6): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function generateHash(length = 10): string {
  // url-safe slug for /s/<hash>
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += alphabet[b % alphabet.length];
  return out;
}

export async function hashCode(
  code: string,
): Promise<{ hash: string; salt: string }> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(code, salt);
  return { hash: toB64(hash), salt: toB64(salt) };
}

export async function verifyCode(
  code: string,
  saltB64: string,
  hashB64: string,
): Promise<boolean> {
  const salt = fromB64(saltB64);
  const expected = fromB64(hashB64);
  const actual = await pbkdf2(code, salt);
  return timingSafeEqual(expected, actual);
}

async function pbkdf2(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const codeBytes = new TextEncoder().encode(code);
  const key = await crypto.subtle.importKey(
    "raw",
    codeBytes.buffer as ArrayBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const saltBuf = salt.buffer.slice(
    salt.byteOffset,
    salt.byteOffset + salt.byteLength,
  ) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
