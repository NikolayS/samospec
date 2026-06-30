-- samospec.dev — initial schema
-- One table, intentionally small. SPEC bodies are stored inline as markdown
-- text; they are typically <1 MiB and Postgres handles this comfortably.

create extension if not exists pgcrypto;

create table if not exists specs (
  hash          text primary key,
  title         text        not null,
  body_md       text        not null,
  -- null = publicly viewable; non-null = PBKDF2 hash of the 6-char code
  code_hash     text,
  code_salt     text,
  -- bookkeeping
  publisher_ip  inet,
  byte_size     int         not null,
  view_count    int         not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists specs_created_at_idx on specs (created_at desc);

-- API keys for the publish endpoint. The CLI sends `Authorization: Bearer
-- <key>`; we look up the sha256 of the bearer in this table. Keys are
-- provisioned out-of-band (insert via psql) — there is no self-serve
-- signup for v1.
create table if not exists publish_keys (
  key_sha256   text        primary key,
  label        text        not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
