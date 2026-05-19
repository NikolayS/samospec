import postgres from "postgres";

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

export const sql = postgres(url, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});

export type SpecRow = {
  hash: string;
  title: string;
  body_md: string;
  code_hash: string | null;
  code_salt: string | null;
  byte_size: number;
  view_count: number;
  created_at: Date;
  updated_at: Date;
  last_viewed_at: Date | null;
};
