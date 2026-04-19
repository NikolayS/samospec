#!/usr/bin/env bun
// Copyright 2026 Nikolay Samokhvalov.

import { runCli } from "./cli.ts";

const result = await runCli(Bun.argv.slice(2));
if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exit(result.exitCode);
