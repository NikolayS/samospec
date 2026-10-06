# syntax=docker/dockerfile:1.7
#
# samospec.dev — single-container image bundling:
#   - PostgreSQL 15 (supabase/postgres base, with Supabase extensions)
#   - Bun runtime + the Astro web application
#   - s6-overlay supervises both processes under PID 1
#
# Mount three volumes at runtime:
#   -v ./data/postgres:/var/lib/postgresql/data   (PG data dir)
#   -v ./data/files:/var/lib/samospec/files       (uploaded files, future use)
#   -v ./config:/etc/samospec                     (config + secrets)
#
# Expose ports:
#   3000  — Astro web app (front it with nginx/cloudflare for TLS)
#   5432  — PostgreSQL (optional; usually kept internal)

# ---- 1. build stage: compile the Astro app with Bun ---------------------
FROM oven/bun:1.2 AS build
WORKDIR /app

COPY package.json ./
RUN bun install --no-save

COPY tsconfig.json astro.config.mjs ./
COPY src ./src
COPY public ./public
RUN bun run build

# Re-install with only production deps so we can copy a slim node_modules.
RUN rm -rf node_modules && bun install --production --no-save

# ---- 2. runtime stage: Supabase Postgres + Bun + s6-overlay -------------
FROM supabase/postgres:15.8.1.060

ARG S6_OVERLAY_VERSION=3.2.0.2
ARG TARGETARCH

ENV S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/pgsql/bin \
    NODE_ENV=production \
    SAMOSPEC_CONFIG_DIR=/etc/samospec \
    SAMOSPEC_FILES_DIR=/var/lib/samospec/files \
    PGDATA=/var/lib/postgresql/data

USER root

# Install: curl/xz (for s6-overlay), unzip (for bun), tini just-in-case.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils unzip tini \
 && rm -rf /var/lib/apt/lists/*

# s6-overlay: pick the right arch.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) ARCH=x86_64 ;; \
      arm64) ARCH=aarch64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
    curl -fsSLo /tmp/s6-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${ARCH}.tar.xz"; \
    tar -C / -Jxpf /tmp/s6-noarch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-arch.tar.xz; \
    rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# Install Bun globally (the runtime, not just the CLI).
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.21" \
 && mv /root/.bun/bin/bun /usr/local/bin/bun \
 && chmod +x /usr/local/bin/bun

# Prepare external mount points so the image starts cleanly even before
# the operator mounts a host directory.
RUN mkdir -p /etc/samospec /var/lib/samospec/files /var/lib/postgresql/data \
 && chown -R postgres:postgres /var/lib/postgresql/data

# Copy app build output and runtime deps.
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY supabase ./supabase
COPY scripts ./scripts

# s6 service definitions and one-shot init scripts.
COPY container/s6-rc /etc/s6-overlay/s6-rc.d
COPY container/cont-init.d /etc/cont-init.d
COPY container/scripts /usr/local/lib/samospec
RUN chmod +x /etc/cont-init.d/* /usr/local/lib/samospec/*.sh \
 && find /etc/s6-overlay/s6-rc.d -name run -exec chmod +x {} + \
 && find /etc/s6-overlay/s6-rc.d -name up   -exec chmod +x {} +

EXPOSE 3000 5432
VOLUME ["/var/lib/postgresql/data", "/var/lib/samospec/files", "/etc/samospec"]

ENTRYPOINT ["/init"]
