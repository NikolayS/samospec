import type { APIRoute } from "astro";
import { sql } from "../../lib/db";

export const GET: APIRoute = async () => {
  try {
    await sql`select 1`;
    return new Response("ok\n", { status: 200 });
  } catch {
    return new Response("db down\n", { status: 503 });
  }
};
