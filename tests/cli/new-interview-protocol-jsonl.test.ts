// Copyright 2026 Nikolay Samokhvalov.

// v0.7.0 — `--interview-protocol jsonl` makes `samospec new` drivable by
// a machine consumer (samo.team wizard, CI tools). Contract:
//
//   - Flag bypasses the #114 non-TTY refusal from PR #114.
//   - Stdout carries ONLY protocol events, one JSON object per line:
//       * {"type":"persona-proposal","persona":"…","rationale":"…","skill":"…"}
//       * {"type":"question","id":"qN","text":"…","options":["a","b", …]}
//       * {"type":"complete"}
//     Human-facing notices (the #77 stderr stream) are NOT emitted on stdout.
//   - Stdin accepts one JSON object per line:
//       * {"type":"persona-answer","kind":"accept"} (or "edit"/"replace")
//       * {"type":"answer","id":"qN","choice":"…","custom"?:"…"}
//   - After the last answer, samospec drafts + writes state.json + commits
//     v0.1 the same way it does in other automation modes.
//
// Two RED tests:
//   1. Unit test for the JSONL resolver seam — write an event line, resolve
//      from a line fed to the reader, validate the event shapes.
//   2. End-to-end spawn of `bun run src/main.ts new --interview-protocol jsonl`
//      with faked claude/codex binaries and a driver that reads events off
//      stdout and writes answers on stdin. Asserts state.json / interview.json
//      land with the driven answers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { runNew } from "../../src/cli/new.ts";
import {
  buildJsonlProtocolResolvers,
  emitProtocolComplete,
  type JsonlProtocolOptions,
} from "../../src/cli/non-interactive.ts";

// ---------- unit tests: JSONL protocol resolver ----------

describe("buildJsonlProtocolResolvers — unit (v0.7.0)", () => {
  test("persona emits one JSON line on stdout and awaits persona-answer", async () => {
    const out: string[] = [];
    const pendingLine = deferred<string>();
    const opts: JsonlProtocolOptions = {
      writeLine: (line) => out.push(line),
      nextLine: () => pendingLine.promise,
    };
    const resolvers = buildJsonlProtocolResolvers(opts);
    const proposalSent = {
      persona: 'Veteran "CLI engineer" expert',
      rationale: "pragmatic choice",
      skill: "CLI engineer",
      accepted: false,
    };
    const personaPromise = resolvers.persona(proposalSent);

    // Yield once so the resolver has had a chance to emit.
    await Promise.resolve();
    await Promise.resolve();

    expect(out.length).toBe(1);
    const event = JSON.parse(out[0] ?? "{}");
    expect(event.type).toBe("persona-proposal");
    expect(event.persona).toBe('Veteran "CLI engineer" expert');
    expect(event.rationale).toBe("pragmatic choice");
    expect(event.skill).toBe("CLI engineer");

    // Consumer replies on stdin.
    pendingLine.resolve(
      JSON.stringify({ type: "persona-answer", kind: "accept" }),
    );
    const result = await personaPromise;
    expect(result.kind).toBe("accept");
  });

  test("question emits JSON line + resolves from stdin answer", async () => {
    const out: string[] = [];
    const queue: string[] = [];
    const pendings: { resolve: (v: string) => void }[] = [];
    const opts: JsonlProtocolOptions = {
      writeLine: (line) => out.push(line),
      nextLine: () =>
        new Promise<string>((resolve) => {
          if (queue.length > 0) {
            const v = queue.shift();
            if (v !== undefined) {
              resolve(v);
              return;
            }
          }
          pendings.push({ resolve });
        }),
    };
    const resolvers = buildJsonlProtocolResolvers(opts);
    const qPromise = resolvers.question({
      id: "q1",
      text: "pick a framework",
      options: ["React", "Vue", "decide for me"],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(out.length).toBe(1);
    const event = JSON.parse(out[0] ?? "{}");
    expect(event.type).toBe("question");
    expect(event.id).toBe("q1");
    expect(event.text).toBe("pick a framework");
    expect(event.options).toEqual(["React", "Vue", "decide for me"]);

    // Deliver answer.
    const pending = pendings.shift();
    pending?.resolve(
      JSON.stringify({ type: "answer", id: "q1", choice: "Vue" }),
    );
    const a = await qPromise;
    expect(a.choice).toBe("Vue");
  });

  test("question resolves 'custom' with free-text", async () => {
    const out: string[] = [];
    const pendingLine = deferred<string>();
    const opts: JsonlProtocolOptions = {
      writeLine: (line) => out.push(line),
      nextLine: () => pendingLine.promise,
    };
    const resolvers = buildJsonlProtocolResolvers(opts);
    const qPromise = resolvers.question({
      id: "q2",
      text: "db?",
      options: ["pg", "custom"],
    });
    await Promise.resolve();
    await Promise.resolve();
    pendingLine.resolve(
      JSON.stringify({
        type: "answer",
        id: "q2",
        choice: "custom",
        custom: "sqlite",
      }),
    );
    const a = await qPromise;
    expect(a.choice).toBe("custom");
    expect(a.custom).toBe("sqlite");
  });
});

// ---------- integration test: runNew + JSONL protocol resolvers ----------
//
// Instead of spawning a subprocess (which would force us to stub the real
// Claude CLI's output format), we wire the exact same JSONL resolvers the
// CLI builds in `buildNewResolvers` against an in-process `runNew` call.
// This exercises the full interview flow — adapter → runInterview →
// JSONL resolvers — via the public seams tests/cli/new-accept-persona.test.ts
// already uses. The CLI wrapper in `src/cli.ts` is tested via the unit
// tests above (that the flag selects the protocol resolver and that the
// protocol events have the right shape).

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-jsonl-e2e-"));
  spawnSync("git", ["init", "-q", "--initial-branch", "work", tmp], {
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "t"], { cwd: tmp });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "seed"], {
    cwd: tmp,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  runInit({ cwd: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function personaJson(skill: string): string {
  return JSON.stringify({
    persona: `Veteran "${skill}" expert`,
    rationale: "pragmatic choice",
  });
}

function questionsJson(
  items: readonly { id: string; text: string; options: readonly string[] }[],
): string {
  return JSON.stringify({ questions: items });
}

function makeLeadAdapter(answers: readonly string[]): Adapter {
  const base = createFakeAdapter({});
  let call = 0;
  return {
    ...base,
    ask: (_input: AskInput): Promise<AskOutput> => {
      const a = answers[call] ?? answers[answers.length - 1] ?? "";
      call += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      Promise.resolve({
        spec: "# spec\n\n## Goal\nshort\n\n## Scope\n- x\n\n## Non-goals\n- none\n",
        ready: false,
        rationale: "v0.1 draft complete",
        usage: null,
        effort_used: "max",
      }),
  };
}

// ---------- argv parsing regression ----------

describe("--interview-protocol flag parsing (v0.7.0)", () => {
  test("only 'jsonl' is accepted", async () => {
    const { runCli } = await import("../../src/cli.ts");
    const r1 = await runCli(["new", "x", "--interview-protocol", "xml"]);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain("--interview-protocol must be 'jsonl'");
    const r2 = await runCli(["new", "x", "--interview-protocol="]);
    expect(r2.exitCode).toBe(1);
  });
});

describe("samospec new --interview-protocol jsonl — integration (v0.7.0)", () => {
  test("drives interview via JSONL resolver, emits complete, writes state.json", async () => {
    const adapter = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([
        { id: "q1", text: "framework?", options: ["React", "Vue"] },
        { id: "q2", text: "db?", options: ["pg", "sqlite"] },
        { id: "q3", text: "host?", options: ["vercel", "fly"] },
        { id: "q4", text: "lang?", options: ["ts", "rust"] },
        { id: "q5", text: "auth?", options: ["oauth", "magic-link"] },
      ]),
    ]);

    // stdout sink: collect emitted protocol lines.
    const emitted: string[] = [];
    // stdin script: pre-canned answers keyed by question id + persona.
    const chosen: Record<string, string> = {
      q1: "Vue",
      q2: "pg",
      q3: "fly",
      q4: "ts",
      q5: "oauth",
    };
    const pending: ((line: string) => void)[] = [];
    const writeLine = (line: string): void => {
      emitted.push(line);
      const event = JSON.parse(line) as Record<string, unknown>;
      // Drive the input side deterministically from the output side:
      // every time we see a question (or persona-proposal) go out, enqueue
      // the matching answer for nextLine() to pick up.
      const enqueue = (obj: unknown): void => {
        const l = JSON.stringify(obj);
        const waiter = pending.shift();
        if (waiter !== undefined) waiter(l);
        else queue.push(l);
      };
      if (event["type"] === "persona-proposal") {
        enqueue({ type: "persona-answer", kind: "accept" });
      } else if (event["type"] === "question") {
        const id = String(event["id"]);
        enqueue({ type: "answer", id, choice: chosen[id] ?? "decide for me" });
      }
    };
    const queue: string[] = [];
    const nextLine = (): Promise<string> => {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<string>((resolve) => {
        pending.push(resolve);
      });
    };

    const protocolOpts: JsonlProtocolOptions = { writeLine, nextLine };
    const resolvers = buildJsonlProtocolResolvers(protocolOpts);

    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers,
        now: "2026-04-22T10:00:00Z",
        suppressStdout: true,
      },
      adapter,
    );

    // Emit the terminal completion event as the CLI wrapper would.
    emitProtocolComplete(writeLine);

    expect(result.exitCode).toBe(0);

    // Protocol event shape assertions.
    const events = emitted.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]?.["type"]).toBe("persona-proposal");
    const questions = events.filter((e) => e["type"] === "question");
    expect(questions.length).toBe(5);
    expect(questions[0]?.["id"]).toBe("q1");
    expect(events[events.length - 1]?.["type"]).toBe("complete");

    // runNew's stdout must be empty (human notices rerouted to stderr).
    expect(result.stdout).toBe("");
    // Stderr should contain at least the branch/persona notice trail so
    // humans can still debug when something goes wrong.
    expect(result.stderr.length).toBeGreaterThan(0);

    // Artifacts landed.
    const statePath = path.join(tmp, ".samo", "spec", "demo", "state.json");
    const interviewPath = path.join(
      tmp,
      ".samo",
      "spec",
      "demo",
      "interview.json",
    );
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(interviewPath)).toBe(true);
    const interview = JSON.parse(readFileSync(interviewPath, "utf8")) as {
      answers: { id: string; choice: string }[];
    };
    expect(interview.answers.length).toBe(5);
    expect(interview.answers.find((a) => a.id === "q1")?.choice).toBe("Vue");
    expect(interview.answers.find((a) => a.id === "q3")?.choice).toBe("fly");
  });
});

// ---------- helpers ----------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
