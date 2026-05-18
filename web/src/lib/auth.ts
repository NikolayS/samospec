import { sql } from "./db";

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authorizePublish(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const keySha = await sha256Hex(match[1]!);
  const rows = await sql<{ key_sha256: string }[]>`
    select key_sha256
      from publish_keys
     where key_sha256 = ${keySha}
       and revoked_at is null
     limit 1
  `;
  return rows.length === 1;
}
