#!/usr/bin/env bun
// Tiny smoke check: generate a code, hash it, verify the round-trip.
import { generateCode, generateHash, hashCode, verifyCode } from "../src/lib/codes";

const code = generateCode();
const hash = generateHash();
const { hash: h, salt: s } = await hashCode(code);
const ok = await verifyCode(code, s, h);
const bad = await verifyCode("WRONG1", s, h);

console.log({ code, hash, codeHash: h, codeSalt: s, ok, bad });
if (!ok) {
  console.error("FAIL: correct code did not verify");
  process.exit(1);
}
if (bad) {
  console.error("FAIL: wrong code verified");
  process.exit(1);
}
console.log("ok");
