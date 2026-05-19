#!/usr/bin/env bun
// Apply SQL migrations in supabase/migrations/ in lexical order, exactly
// once. Tracks applied filenames + sha256 in the schema_migrations table.
// On re-run, verifies that the on-disk contents match the recorded hash
// so an edited migration is caught instead of silently skipped.

import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const sql = postgres(url, { max: 1, prepare: false });

async function main(): Promise<void> {
  // Bootstrap the tracking table. The sha256 column is added by
  // 0002_security.sql; ensure it exists on legacy installs too.
  await sql`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  await sql`alter table schema_migrations add column if not exists sha256 text`;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Map(
    (
      await sql<
        { filename: string; sha256: string | null }[]
      >`select filename, sha256 from schema_migrations`
    ).map((r) => [r.filename, r.sha256]),
  );

  for (const file of files) {
    const body = await readFile(join(migrationsDir, file), "utf8");
    const sha = createHash("sha256").update(body).digest("hex");

    const recordedSha = applied.get(file);
    if (recordedSha !== undefined) {
      if (recordedSha && recordedSha !== sha) {
        console.error(
          `FAIL: ${file} content has changed since it was applied ` +
            `(recorded ${recordedSha.slice(0, 12)}..., now ${sha.slice(0, 12)}...)`,
        );
        await sql.end();
        process.exit(1);
      }
      if (!recordedSha) {
        // Backfill checksum for rows from earlier migrate.ts runs.
        await sql`update schema_migrations set sha256 = ${sha} where filename = ${file}`;
      }
      console.log(`skip   ${file}`);
      continue;
    }

    console.log(`apply  ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        insert into schema_migrations (filename, sha256)
        values (${file}, ${sha})
      `;
    });
  }

  await sql.end();
}

await main();
