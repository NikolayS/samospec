#!/usr/bin/env bun
// Issue a new publish API key. Usage: bun run scripts/issue-key.ts <label>
// Prints the bearer token to stdout exactly once — store it now.

import postgres from "postgres";

const label = process.argv[2];
if (!label) {
  console.error("usage: bun run scripts/issue-key.ts <label>");
  process.exit(2);
}

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const sql = postgres(url, { max: 1, prepare: false });

const token = randomToken(40);
const sha = await sha256Hex(token);

await sql`
  insert into publish_keys (key_sha256, label) values (${sha}, ${label})
`;
await sql.end();

console.log(token);

function randomToken(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (const b of buf) s += alphabet[b % alphabet.length];
  return s;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
