// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §3 + Issue #107 — atomic read/write for architecture.json.
 * Mirrors the state/store.ts atomicity pattern (temp file + fsync +
 * rename) so a crash mid-write leaves either the old file or nothing.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  architectureSchema,
  emptyArchitecture,
  type Architecture,
} from "./architecture.ts";

/**
 * Read architecture.json from disk. Returns `null` when the file is
 * absent. Throws on I/O or schema errors so the CLI surfaces the
 * problem as an exit-1 "state is malformed" rather than silently
 * falling back to the empty document.
 */
export function readArchitecture(file: string): Architecture | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `architecture.json at ${file} could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `architecture.json at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const result = architectureSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `architecture.json at ${file} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Read architecture.json, falling back to `emptyArchitecture()` when
 * the file is absent. Used by render/iterate paths that always want a
 * document to pass to the ASCII renderer.
 */
export function readArchitectureOrEmpty(file: string): Architecture {
  return readArchitecture(file) ?? emptyArchitecture();
}

/**
 * Atomic write: validate → write to `.tmp.<pid>` sibling → fsync →
 * rename over the target → fsync the parent dir. Refuses to write an
 * invalid document.
 */
export function writeArchitecture(file: string, doc: Architecture): void {
  const parsed = architectureSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `refusing to write invalid architecture to ${file}: ${parsed.error.message}`,
    );
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  const payload = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, payload, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Windows + some filesystems disallow directory fsync; rename
    // remains atomic.
  }
}
