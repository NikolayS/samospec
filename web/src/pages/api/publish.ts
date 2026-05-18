import type { APIRoute } from "astro";
import { sql } from "../../lib/db";
import { authorizePublish } from "../../lib/auth";
import { generateCode, generateHash, hashCode } from "../../lib/codes";

const MAX_BODY_BYTES = 1_048_576; // 1 MiB cap
const MAX_TITLE = 200;

type PublishRequest = {
  title?: unknown;
  body_md?: unknown;
  // "auto" → server generates a 6-char code and returns it.
  // "none" → spec is public.
  // string → caller-supplied code (uppercased, 4-12 chars).
  code?: unknown;
};

export const POST: APIRoute = async ({ request }) => {
  if (!(await authorizePublish(request))) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: PublishRequest;
  try {
    payload = (await request.json()) as PublishRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const title = String(payload.title ?? "").trim();
  const bodyMd = String(payload.body_md ?? "");
  if (!title || title.length > MAX_TITLE) {
    return json({ error: "invalid_title" }, 400);
  }
  if (!bodyMd || new Blob([bodyMd]).size > MAX_BODY_BYTES) {
    return json({ error: "invalid_body" }, 400);
  }

  let code: string | null = null;
  let codeHash: string | null = null;
  let codeSalt: string | null = null;
  if (payload.code === "auto") {
    code = generateCode(6);
  } else if (typeof payload.code === "string" && payload.code !== "none") {
    code = payload.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      return json({ error: "invalid_code" }, 400);
    }
  }
  if (code) {
    const hashed = await hashCode(code);
    codeHash = hashed.hash;
    codeSalt = hashed.salt;
  }

  // Generate a unique hash. Collisions are vanishingly rare at 10×log2(32)=50
  // bits, but retry a few times to be safe.
  let hash = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    hash = generateHash(10);
    const existing =
      await sql`select 1 from specs where hash = ${hash} limit 1`;
    if (existing.length === 0) break;
    hash = "";
  }
  if (!hash) return json({ error: "hash_collision" }, 500);

  const ip = request.headers.get("cf-connecting-ip") ?? null;
  const byteSize = new Blob([bodyMd]).size;

  await sql`
    insert into specs
      (hash, title, body_md, code_hash, code_salt, publisher_ip, byte_size)
    values
      (${hash}, ${title}, ${bodyMd}, ${codeHash}, ${codeSalt},
       ${ip}, ${byteSize})
  `;

  return json({
    hash,
    url: `https://samospec.dev/s/${hash}`,
    code: code, // returned only when generated/accepted
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
