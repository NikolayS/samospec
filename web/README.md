# samospec.dev

The website for `samospec` — a static landing page plus a "publish your spec
to a shareable URL" service. Packaged as a **single self-contained Docker
image** that bundles PostgreSQL (`supabase/postgres`), the Bun-based Astro
web app, and s6-overlay as the process supervisor.

All dynamic data and configuration lives outside the container on three
host-mounted volumes.

- `./data/postgres` → `/var/lib/postgresql/data` (PG data dir)
- `./data/files` → `/var/lib/samospec/files` (uploaded files; reserved for future use)
- `./config` → `/etc/samospec` (config + secrets; auto-generated on first boot)

## Quick start

```bash
cd web
./scripts/run.sh build
./scripts/run.sh up -d
./scripts/run.sh logs
```

On first boot the container writes `config/samospec.env` with a generated
`POSTGRES_PASSWORD`. Read it back if you need to connect from the host.

Open <http://localhost:3000> — landing page should load. The spec viewer
at `/s/<hash>` returns 404 until you publish something.

### Issue a publish API key

The publish endpoint is bearer-auth-gated. Mint a key after the container
is up:

```bash
./scripts/run.sh issue-key "my-laptop"
# → prints a 40-char token. Save it; the token is only shown once.
```

### Publish a spec by hand (for testing)

```bash
TOKEN="<token from issue-key>"
curl -sS -X POST http://localhost:3000/api/publish \
  -H "authorization: Bearer ${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg t 'My first spec' --arg b "$(cat ../README.md)" \
        '{title:$t, body_md:$b, code:"auto"}')" | jq
# → { hash, url, code }
```

Then visit the returned `url` in a browser; enter the `code` if one was
returned. Without a `code` parameter (or with `code: "none"`) the spec is
public.

## Development (no container)

```bash
cd web
bun install
docker run --rm -d --name samo-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -v "$(pwd)/data/postgres:/var/lib/postgresql/data" \
  supabase/postgres:15.8.1.060
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres'
bun run scripts/migrate.ts
bun run dev    # http://localhost:4321
```

## Layout

```text
web/
├── Dockerfile              single-image build: supabase/postgres + bun + app
├── astro.config.mjs        Astro in SSR mode, Node adapter, standalone
├── container/              container-only assets
│   ├── cont-init.d/        one-shot init scripts (config, pg initdb)
│   ├── s6-rc/              s6-overlay service definitions
│   └── scripts/            helpers invoked from s6 services
├── public/                 static assets served by Astro
├── scripts/                build/run helpers + migration runner
├── src/
│   ├── layouts/Layout.astro
│   ├── lib/
│   │   ├── auth.ts         publish-key bearer check
│   │   ├── codes.ts        access-code generation + PBKDF2 verify
│   │   ├── db.ts           postgres.js client
│   │   └── markdown.ts     marked + sanitize-html
│   ├── pages/
│   │   ├── index.astro     landing page
│   │   ├── s/[hash].astro  spec viewer (code-gated when applicable)
│   │   └── api/
│   │       ├── publish.ts  POST a spec
│   │       └── healthz.ts  liveness probe
│   └── styles/global.css
└── supabase/migrations/    SQL migrations applied at container start
```

## Endpoints

- `GET /` — landing page (static SSR).
- `GET /s/:hash` — render a published spec. If `code_hash` is set on the row,
  serves a code-entry form and validates submissions against PBKDF2(code, salt).
- `POST /api/publish` — accepts `{ title, body_md, code }` JSON; `code` may be
  `"auto"` (server generates), `"none"` (public), or a literal 4–12 char string.
  Returns `{ hash, url, code? }`.
- `GET /api/healthz` — DB liveness check.

## Operational notes

- The container listens on **3000** (HTTP). Front it with nginx, Caddy, or
  Cloudflare for TLS termination at the edge.
- Postgres binds **127.0.0.1** inside the container only — not reachable from
  the host even though the Dockerfile `EXPOSE`s 5432 for documentation.
- `config/samospec.env` is generated on first boot if missing. **Edit it
  before initdb runs** if you want a specific `POSTGRES_PASSWORD`; once the
  data dir is initialised the password is baked in.
- Migrations are idempotent and run on every boot. Adding a new SQL file in
  `supabase/migrations/` and rebuilding the image is the supported flow for
  schema changes.
