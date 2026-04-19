// Copyright 2026 Nikolay Samokhvalov.

import { describe, test } from "bun:test";

import { runAdapterContract } from "../../src/adapter/contract-test.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";

describe("adapter contract (SPEC §13 test 4)", () => {
  test("the reference fake adapter passes the full contract suite", async () => {
    await runAdapterContract({
      name: "fake",
      makeAdapter: () => createFakeAdapter(),
    });
  });
});
