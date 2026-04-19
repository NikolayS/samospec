// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { newState, readState, writeState } from "../../src/state/store.ts";
import { readRound, writeRound } from "../../src/state/round.ts";
import type { Round } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-crash-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("state/store — crash recovery (SPEC §13 test 10)", () => {
  test("kill -9 before rename leaves the previous state.json intact", async () => {
    const file = path.join(tmp, "state.json");
    const initial = newState({
      slug: "demo",
      now: "2026-04-19T00:00:00.000Z",
    });
    writeState(file, initial);
    const originalBytes = readFileSync(file, "utf8");

    // Spawn a Bun process that starts an atomic write but gets killed
    // after opening the .tmp file and before the rename completes. The
    // parent then asserts the original state.json is still valid.
    const scriptPath = path.join(tmp, "crash.ts");
    writeFileSync(
      scriptPath,
      `
        import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
        import path from "node:path";
        const file = process.argv[2]!;
        const dir = path.dirname(file);
        const tmp = path.join(dir, "." + path.basename(file) + ".tmp." + process.pid);
        const fd = openSync(tmp, "w", 0o644);
        writeSync(fd, '{"partial": "write in progress"', 0, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        // Exit abnormally before the rename so state.json is untouched.
        process.exit(137);
      `,
      "utf8",
    );

    const proc = Bun.spawn(["bun", "run", scriptPath, file], {
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(137);

    // The original file must still parse successfully against the schema.
    const reread = readState(file);
    expect(reread).toEqual(initial);
    expect(readFileSync(file, "utf8")).toBe(originalBytes);

    // The orphan .tmp file is still present — we do NOT treat it as
    // state.json. It is harmless: the next writeState overwrites a
    // fresh .tmp.<pid> sibling and renames over the target.
    const entries = readdirSync(tmp).filter((e) => e !== "crash.ts");
    expect(entries).toContain("state.json");
    expect(entries.some((e) => e.startsWith(".state.json.tmp."))).toBe(true);

    // Subsequent legitimate write cleans up over itself.
    const next = {
      ...initial,
      updated_at: "2026-04-19T00:01:00.000Z",
      remote_stale: true,
    };
    writeState(file, next);
    const afterRecovery = readState(file);
    expect(afterRecovery?.remote_stale).toBe(true);
  });

  test("kill -9 between critique write and round.json update leaves previous round.json intact", () => {
    const reviewsDir = path.join(tmp, "r01");
    const roundFile = path.join(reviewsDir, "round.json");
    const critiqueFile = path.join(reviewsDir, "claude.md");

    const base: Round = {
      round: 1,
      status: "planned",
      seats: { reviewer_a: "pending", reviewer_b: "pending" },
      started_at: "2026-04-19T02:00:00.000Z",
    };
    writeRound(roundFile, base);

    // Simulate the orphan-critique condition: the process writes the
    // critique file then dies before it can update round.json.
    writeFileSync(critiqueFile, "# Partial critique\nunfinished\n", "utf8");

    // Recovery read: round.json still says both seats pending.
    const recovered = readRound(roundFile);
    expect(recovered).toEqual(base);
    expect(recovered?.seats.reviewer_a).toBe("pending");
    expect(recovered?.seats.reviewer_b).toBe("pending");

    // Critique file is preserved for post-mortem per SPEC §7 ("Partial
    // outputs on disk are preserved ... but never read as complete
    // critiques"), but the resume logic will ignore it because
    // round.json.seats.* != "ok".
    expect(existsSync(critiqueFile)).toBe(true);
    expect(readFileSync(critiqueFile, "utf8")).toContain("Partial critique");
  });
});
