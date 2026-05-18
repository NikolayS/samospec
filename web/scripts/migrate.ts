#!/usr/bin/env bun
// Apply SQL migrations in supabase/migrations/ in lexical order, exactly once.
// Tracks applied filenames in the schema_migrations table.

import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const sql = postgres(url, { max: 1, prepare: false });

async function main(): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (
      await sql<{ filename: string }[]>`select filename from schema_migrations`
    ).map((r) => r.filename),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file}`);
      continue;
    }
    const body = await readFile(join(migrationsDir, file), "utf8");
    console.log(`apply  ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename) values (${file})`;
    });
  }

  await sql.end();
}

await main();
