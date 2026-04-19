// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readState,
  writeState,
  readStateOrThrow,
  newState,
} from "../../src/state/store.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("state/store — read + write (SPEC §7)", () => {
  test("writeState + readState round-trips a fresh state", () => {
    const file = path.join(tmp, "state.json");
    const fresh = newState({ slug: "demo", now: "2026-04-19T00:00:00.000Z" });
    writeState(file, fresh);
    const loaded = readState(file);
    expect(loaded).toEqual(fresh);
  });

  test("readState returns null when the file is absent", () => {
    const file = path.join(tmp, "missing.json");
    expect(readState(file)).toBeNull();
  });

  test("readStateOrThrow throws when the file is absent", () => {
    const file = path.join(tmp, "missing.json");
    expect(() => readStateOrThrow(file)).toThrow(/not found/i);
  });

  test("readState throws a clear error when the file is malformed JSON", () => {
    const file = path.join(tmp, "state.json");
    writeFileSync(file, "not json at all", "utf8");
    expect(() => readState(file)).toThrow(/state\.json/);
  });

  test("readState throws a clear error when the schema is violated", () => {
    const file = path.join(tmp, "state.json");
    writeFileSync(file, JSON.stringify({ slug: "demo" }), "utf8");
    expect(() => readState(file)).toThrow(/state\.json/);
  });

  test("writeState creates the parent directory if missing", () => {
    const file = path.join(tmp, "nested", "deep", "state.json");
    const fresh = newState({ slug: "demo", now: "2026-04-19T00:00:00.000Z" });
    writeState(file, fresh);
    expect(existsSync(file)).toBe(true);
  });

  test("writeState is atomic: no temp file left after success", () => {
    const dir = path.join(tmp, "atomic");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "state.json");
    writeState(
      file,
      newState({ slug: "demo", now: "2026-04-19T00:00:00.000Z" }),
    );
    const entries = readdirSync(dir);
    // Only the final file; the .tmp.* sibling has been renamed away.
    expect(entries).toEqual(["state.json"]);
  });

  test("writeState preserves the previous file if called with an invalid state", () => {
    const file = path.join(tmp, "state.json");
    const fresh = newState({ slug: "demo", now: "2026-04-19T00:00:00.000Z" });
    writeState(file, fresh);
    const bogus = { ...fresh, phase: "not_a_phase" } as unknown as typeof fresh;
    expect(() => writeState(file, bogus)).toThrow(/state/i);
    const reread = readState(file);
    expect(reread).toEqual(fresh);
  });

  test("newState starts in detect phase, round 0, planned, version 0.0.0", () => {
    const s = newState({ slug: "demo", now: "2026-04-19T00:00:00.000Z" });
    expect(s.phase).toBe("detect");
    expect(s.round_index).toBe(0);
    expect(s.round_state).toBe("planned");
    expect(s.version).toBe("0.0.0");
    expect(s.remote_stale).toBe(false);
    expect(s.coupled_fallback).toBe(false);
    expect(s.persona).toBeNull();
    expect(s.push_consent).toBeNull();
    expect(s.calibration).toBeNull();
    expect(s.exit).toBeNull();
    expect(s.created_at).toBe("2026-04-19T00:00:00.000Z");
    expect(s.updated_at).toBe("2026-04-19T00:00:00.000Z");
  });
});
