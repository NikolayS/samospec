// Copyright 2026 Nikolay Samokhvalov.

/**
 * scripts/bump-version.ts — update package.json version + CHANGELOG stub.
 *
 * Usage:
 *   bun run scripts/bump-version.ts <new-version> [--pkg <path>] [--changelog <path>]
 *
 * Options:
 *   <new-version>         Required. SemVer string e.g. "0.3.0".
 *   --pkg <path>          Path to package.json (default: package.json in cwd).
 *   --changelog <path>    Path to CHANGELOG.md (default: CHANGELOG.md in cwd).
 *
 * Exits 0 on success, 1 on error.
 * Does NOT commit — caller commits via the normal release flow.
 *
 * Release flow per CLAUDE.md:
 *   1. bun run scripts/bump-version.ts <version>
 *   2. git add package.json CHANGELOG.md
 *   3. git commit -m "chore: bump version to <version>"
 *   4. git tag v<version>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ISO_DATE = new Date().toISOString().slice(0, 10); // yyyy-mm-dd

function usage(): never {
  process.stderr.write(
    "Usage: bun run scripts/bump-version.ts <version> " +
      "[--pkg <path>] [--changelog <path>]\n",
  );
  process.exit(1);
}

function main(argv: readonly string[]): void {
  const args = [...argv];
  const version = args.shift();
  if (version === undefined || !SEMVER_RE.test(version)) {
    process.stderr.write(
      `error: first argument must be a SemVer string (e.g. 0.3.0), got: ${version ?? "(none)"}\n`,
    );
    usage();
  }

  let pkgPath: string | undefined;
  let changelogPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pkg") {
      pkgPath = args[++i];
    } else if (arg === "--changelog") {
      changelogPath = args[++i];
    } else {
      process.stderr.write(`error: unknown argument: ${arg ?? "(none)"}\n`);
      usage();
    }
  }

  const cwd = process.cwd();
  const resolvedPkg = pkgPath ?? path.join(cwd, "package.json");
  const resolvedChangelog = changelogPath ?? path.join(cwd, "CHANGELOG.md");

  // ---------- bump package.json ----------
  if (!existsSync(resolvedPkg)) {
    process.stderr.write(`error: package.json not found at ${resolvedPkg}\n`);
    process.exit(1);
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(resolvedPkg, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    process.stderr.write(
      `error: cannot parse ${resolvedPkg}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  pkg["version"] = version;
  writeFileSync(resolvedPkg, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  process.stdout.write(`bumped package.json version to ${version}\n`);

  // ---------- scaffold CHANGELOG entry ----------
  const newEntry =
    `\n## [${version}] - ${ISO_DATE}\n\n` +
    `### Added\n\n- (describe additions)\n\n` +
    `### Fixed\n\n- (describe fixes)\n\n` +
    `### Changed\n\n- (describe changes)\n`;

  if (existsSync(resolvedChangelog)) {
    const existing = readFileSync(resolvedChangelog, "utf8");
    // Insert after the first heading line (# Changelog or similar) so the
    // new entry appears at the top of the version list.
    const firstHeadingEnd = existing.indexOf("\n");
    if (firstHeadingEnd !== -1) {
      const updated =
        existing.slice(0, firstHeadingEnd + 1) +
        newEntry +
        existing.slice(firstHeadingEnd + 1);
      writeFileSync(resolvedChangelog, updated, "utf8");
    } else {
      writeFileSync(resolvedChangelog, existing + newEntry, "utf8");
    }
  } else {
    writeFileSync(resolvedChangelog, `# Changelog\n${newEntry}`, "utf8");
  }
  process.stdout.write(
    `scaffolded CHANGELOG entry for [${version}] - ${ISO_DATE}\n`,
  );
}

main(process.argv.slice(2));
