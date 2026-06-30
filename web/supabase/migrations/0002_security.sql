-- samospec.dev — security & operational hardening (review #178)
--
-- 1. per-spec brute-force throttle on the code gate (no client-IP trust)
-- 2. last_viewed_at for view-count throttling
-- 3. sha256 column on schema_migrations for tamper detection

alter table specs
  add column if not exists code_failures      int not null default 0,
  add column if not exists code_locked_until  timestamptz,
  add column if not exists last_viewed_at     timestamptz;

create index if not exists specs_code_locked_until_idx
  on specs (code_locked_until)
  where code_locked_until is not null;

-- schema_migrations is created lazily by scripts/migrate.ts before the
-- first migration runs, so it already exists when this file is applied.
alter table schema_migrations
  add column if not exists sha256 text;
