// Hashing for the optional 6-character access code on a published spec,
// plus URL hash generation and the shared alphabets used by both.
//
// PBKDF2 + HMAC via Web Crypto so we have no native deps inside the
// container.

const ITERATIONS = 200_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

// Unambiguous alphabet: digits + uppercase, minus 0/O/1/I. Used for
// human-readable access codes.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// URL-safe slug alphabet: lowercase + digits, minus l/o/1/0 to avoid
// transcription mistakes. The /s/[hash] route validates against this same
// set (see HASH_REGEX).
export const HASH_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const HASH_REGEX = /^[a-z0-9]{6,32}$/;

export function generateCode(length = 6): string {
  return drawFromAlphabet(CODE_ALPHABET, length);
}

export function generateHash(length = 10): string {
  return drawFromAlphabet(HASH_ALPHABET, length);
}

function drawFromAlphabet(alphabet: string, length: number): string {
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

// HMAC-SHA256 in hex. Used to sign session cookies so that a leaked DB
// snapshot (which contains code_hash) is not sufficient to mint cookies.
export async function hmacHex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string compare. Strings of differing length still
// short-circuit, which is the correct behaviour for fixed-length tokens
// like HMAC outputs.
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
