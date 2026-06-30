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

// Reject cross-origin POSTs. Astro renders forms from the same origin, so
// any other Origin header value is a forged-request attempt. We accept
// missing Origin (some clients omit it on same-origin POSTs from older
// browsers) but require the value to match when present.
export function isSameOriginPost(req: Request): boolean {
  if (req.method !== "POST") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const expected = expectedOrigin(req);
  return origin === expected;
}

function expectedOrigin(req: Request): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (base) return base.replace(/\/+$/, "");
  // Fallback: derive from the request URL.
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

// Pull the publisher IP. We do NOT trust X-Forwarded-For or
// CF-Connecting-IP unless TRUST_FORWARDED_IPS is explicitly enabled in
// the container's config — the alternative is that any direct caller can
// spoof publisher_ip. With trust disabled (the default) we leave the
// column NULL, which is honest about what we can prove.
export function publisherIp(req: Request): string | null {
  if (process.env.TRUST_FORWARDED_IPS !== "1") return null;
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}
