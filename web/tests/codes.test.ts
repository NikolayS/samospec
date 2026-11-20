import { describe, expect, test } from "bun:test";
import {
  CODE_ALPHABET,
  HASH_ALPHABET,
  HASH_REGEX,
  generateCode,
  generateHash,
  hashCode,
  hmacHex,
  timingSafeStringEqual,
  verifyCode,
} from "../src/lib/codes";

describe("code generation", () => {
  test("generateCode draws from the code alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  test("generateHash draws from the slug alphabet and matches HASH_REGEX", () => {
    for (let i = 0; i < 50; i++) {
      const h = generateHash();
      expect(h).toHaveLength(10);
      for (const ch of h) expect(HASH_ALPHABET.includes(ch)).toBe(true);
      expect(HASH_REGEX.test(h)).toBe(true);
    }
  });
});

describe("code hashing", () => {
  test("correct code verifies", async () => {
    const code = generateCode();
    const { hash, salt } = await hashCode(code);
    expect(await verifyCode(code, salt, hash)).toBe(true);
  });

  test("wrong code does not verify", async () => {
    const { hash, salt } = await hashCode("ABCDEF");
    expect(await verifyCode("ABCDEG", salt, hash)).toBe(false);
    expect(await verifyCode("", salt, hash)).toBe(false);
  });

  test("salts are unique per call", async () => {
    const a = await hashCode("SAMECODE");
    const b = await hashCode("SAMECODE");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("HMAC + timing-safe compare", () => {
  test("hmacHex is deterministic and depends on the secret", async () => {
    const a = await hmacHex("secret1", "spec:abc:hash");
    const b = await hmacHex("secret1", "spec:abc:hash");
    const c = await hmacHex("secret2", "spec:abc:hash");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64); // sha-256 hex
  });

  test("timingSafeStringEqual handles equal, unequal, and different-length", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});
