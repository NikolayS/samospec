// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { isNoRead, NO_READ_PATTERNS } from "../../src/context/no-read.ts";

describe("context/no-read — hard-coded credential list (SPEC §7)", () => {
  test("matches .env and variants case-insensitively", () => {
    expect(isNoRead(".env")).toBe(true);
    expect(isNoRead(".env.staging")).toBe(true);
    expect(isNoRead(".env.local")).toBe(true);
    expect(isNoRead(".env.production.local")).toBe(true);
    expect(isNoRead("sub/dir/.env.staging")).toBe(true);
    // Case-insensitive.
    expect(isNoRead(".ENV")).toBe(true);
  });

  test("matches .npmrc / .pypirc / .netrc / dotfile family", () => {
    expect(isNoRead(".npmrc")).toBe(true);
    expect(isNoRead(".pypirc")).toBe(true);
    expect(isNoRead(".netrc")).toBe(true);
  });

  test("matches AWS / SSH / kube / docker credential locations", () => {
    expect(isNoRead(".aws/credentials")).toBe(true);
    expect(isNoRead(".aws/config")).toBe(true);
    expect(isNoRead("subdir/.aws/credentials")).toBe(true);
    expect(isNoRead(".ssh/id_rsa")).toBe(true);
    expect(isNoRead(".ssh/known_hosts")).toBe(true);
    expect(isNoRead(".kube/config")).toBe(true);
    expect(isNoRead(".docker/config.json")).toBe(true);
    expect(isNoRead(".dockercfg")).toBe(true);
  });

  test("matches private-key extensions", () => {
    expect(isNoRead("keys/api.pem")).toBe(true);
    expect(isNoRead("service.key")).toBe(true);
    expect(isNoRead("cert.p12")).toBe(true);
    expect(isNoRead("cert.pfx")).toBe(true);
    expect(isNoRead("CERT.PEM")).toBe(true);
  });

  test("matches ssh id_* family", () => {
    expect(isNoRead("id_rsa")).toBe(true);
    expect(isNoRead("id_rsa.pub")).toBe(true);
    expect(isNoRead("id_ed25519")).toBe(true);
    expect(isNoRead("id_ecdsa")).toBe(true);
  });

  test("matches 'credentials*' case-insensitively", () => {
    expect(isNoRead("credentials")).toBe(true);
    expect(isNoRead("credentials.json")).toBe(true);
    expect(isNoRead("my/CREDENTIALS.yaml")).toBe(true);
  });

  test("matches anything under .git/", () => {
    expect(isNoRead(".git/HEAD")).toBe(true);
    expect(isNoRead(".git/refs/heads/main")).toBe(true);
    expect(isNoRead("nested/.git/HEAD")).toBe(true);
  });

  test("does NOT match ordinary files", () => {
    expect(isNoRead("README.md")).toBe(false);
    expect(isNoRead("src/index.ts")).toBe(false);
    expect(isNoRead("package.json")).toBe(false);
    // "env" without leading dot is not a secret file.
    expect(isNoRead("environment.md")).toBe(false);
    expect(isNoRead("docs/env-notes.md")).toBe(false);
  });

  test("no-read list is exposed for auditability", () => {
    expect(NO_READ_PATTERNS.length).toBeGreaterThan(5);
  });
});
