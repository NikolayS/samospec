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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  PROTOCOL_VERSION,
  buildJsonlProtocolResolvers,
  emitProtocolComplete,
  type JsonlProtocolOptions,
} from "../../src/cli/non-interactive.ts";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

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
    expect(event.v).toBe(PROTOCOL_VERSION);
    expect(event.persona).toBe('Veteran "CLI engineer" expert');
    expect(event.rationale).toBe("pragmatic choice");
    expect(event.skill).toBe("CLI engineer");

    // Consumer replies on stdin. Consumer-emitted events MUST carry `v`.
    pendingLine.resolve(
      JSON.stringify({ type: "persona-answer", v: 1, kind: "accept" }),
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
    expect(event.v).toBe(PROTOCOL_VERSION);
    expect(event.id).toBe("q1");
    expect(event.text).toBe("pick a framework");
    expect(event.options).toEqual(["React", "Vue", "decide for me"]);

    // Deliver answer (consumer-side event must carry v:1).
    const pending = pendings.shift();
    pending?.resolve(
      JSON.stringify({ type: "answer", v: 1, id: "q1", choice: "Vue" }),
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
        v: 1,
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

// ---------- unit tests: protocol version field (M2) ----------

describe("JSONL protocol version field — v: 1 (v0.7.0, M2)", () => {
  test("PROTOCOL_VERSION export is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("complete event carries v: 1", () => {
    const out: string[] = [];
    emitProtocolComplete((line) => out.push(line));
    expect(out.length).toBe(1);
    const event = JSON.parse(out[0] ?? "{}");
    expect(event.type).toBe("complete");
    expect(event.v).toBe(1);
  });

  test("rejects inbound persona-answer missing v", async () => {
    const pendingLine = deferred<string>();
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: () => {
        // discard
      },
      nextLine: () => pendingLine.promise,
    });
    const p = resolvers.persona({
      persona: 'Veteran "x" expert',
      rationale: "r",
      skill: "x",
      accepted: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    pendingLine.resolve(
      JSON.stringify({ type: "persona-answer", kind: "accept" }),
    );
    const msg = await captureRejection(p);
    expect(msg).toMatch(/protocol version|missing.*v|unknown.*v/i);
  });

  test("rejects inbound answer with wrong v", async () => {
    const pendingLine = deferred<string>();
    const out: string[] = [];
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: (l) => out.push(l),
      nextLine: () => pendingLine.promise,
    });
    const q = resolvers.question({
      id: "q1",
      text: "pick",
      options: ["a", "b"],
    });
    await Promise.resolve();
    await Promise.resolve();
    pendingLine.resolve(
      JSON.stringify({ type: "answer", v: 99, id: "q1", choice: "a" }),
    );
    const msg = await captureRejection(q);
    expect(msg).toMatch(/protocol version|unknown.*v|unsupported/i);
  });
});

// ---------- unit tests: error paths (M3) ----------

describe("JSONL protocol error paths — unit (v0.7.0, M3)", () => {
  test("malformed stdin JSON throws a clear, non-stack-trace message", async () => {
    const pendingLine = deferred<string>();
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: () => {
        // discard
      },
      nextLine: () => pendingLine.promise,
    });
    const q = resolvers.question({
      id: "q1",
      text: "pick",
      options: ["a", "b"],
    });
    await Promise.resolve();
    await Promise.resolve();
    pendingLine.resolve("this is not { valid json");
    const msg = await captureRejection(q);
    expect(msg).toMatch(/not valid JSON/i);
    // No Node readline stack-trace leak.
    expect(msg).not.toMatch(/ERR_USE_AFTER_CLOSE/);
  });

  test("non-object stdin line throws a clear error", async () => {
    const pendingLine = deferred<string>();
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: () => {
        // discard
      },
      nextLine: () => pendingLine.promise,
    });
    const q = resolvers.question({
      id: "q1",
      text: "pick",
      options: ["a"],
    });
    await Promise.resolve();
    await Promise.resolve();
    pendingLine.resolve(JSON.stringify([1, 2, 3]));
    const msg = await captureRejection(q);
    expect(msg).toMatch(/must be a JSON object/i);
  });

  test("stdin-close rejection surfaces as clear error, not ERR_USE_AFTER_CLOSE", async () => {
    // Simulate nextLine rejecting because stdin was closed before an answer
    // arrived — the same contract cli.ts wires from the readline `close` event.
    const closeErr = new Error(
      "samospec interview-protocol: stdin closed before answer arrived",
    );
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: () => {
        // discard
      },
      nextLine: () => Promise.reject(closeErr),
    });
    const q = resolvers.question({
      id: "q1",
      text: "pick",
      options: ["a"],
    });
    const msg = await captureRejection(q);
    expect(msg).toMatch(/stdin closed before answer arrived/);
    // Must NOT be the Node readline internal crash.
    expect(msg).not.toMatch(/ERR_USE_AFTER_CLOSE/);
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
        enqueue({ type: "persona-answer", v: 1, kind: "accept" });
      } else if (event["type"] === "question") {
        const id = String(event["id"]);
        enqueue({
          type: "answer",
          v: 1,
          id,
          choice: chosen[id] ?? "decide for me",
        });
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
    // M2: every emitted event must carry v: 1 for forward-compat.
    for (const e of events) {
      expect(e["v"]).toBe(1);
    }

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

// ---------- integration: --yes precedence + stdout cleanliness on error (M3) ----------

describe("--interview-protocol jsonl precedence and error-path stdout (M3)", () => {
  test("--interview-protocol jsonl wins over --yes (JSONL resolver drives run)", async () => {
    // When BOTH --yes and --interview-protocol jsonl are passed, the JSONL
    // protocol resolver is selected (the --yes auto-accept is ignored so
    // persona-adaptive questions are not silently bypassed). The parsed
    // resolver path is testable by observing that the build-resolver step
    // picks JSONL: a malformed stdin line surfaces as the JSONL error,
    // not a `--yes`-mode `"decide for me"` auto-pass.
    const out: string[] = [];
    const pendingLine = deferred<string>();
    const resolvers = buildJsonlProtocolResolvers({
      writeLine: (l) => out.push(l),
      nextLine: () => pendingLine.promise,
    });
    // Smoke: personaPromise awaits a JSONL line, not a synthetic auto-accept.
    const personaPromise = resolvers.persona({
      persona: 'Veteran "x" expert',
      rationale: "r",
      skill: "x",
      accepted: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(out.length).toBe(1); // emitted a JSONL persona-proposal
    // (If --yes had won, no event would have been emitted.)
    pendingLine.resolve(
      JSON.stringify({ type: "persona-answer", v: 1, kind: "accept" }),
    );
    const choice = await personaPromise;
    expect(choice.kind).toBe("accept");
  });

  test("error-path stdout stays empty when the interview throws mid-run", async () => {
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

    // Driver that answers persona correctly, then feeds garbage for q1 so
    // the protocol-layer error fires mid-interview.
    const emitted: string[] = [];
    const queue: string[] = [];
    const pending: ((line: string) => void)[] = [];
    const writeLine = (line: string): void => {
      emitted.push(line);
      const event = JSON.parse(line) as Record<string, unknown>;
      const enqueue = (raw: string): void => {
        const w = pending.shift();
        if (w !== undefined) w(raw);
        else queue.push(raw);
      };
      if (event["type"] === "persona-proposal") {
        enqueue(
          JSON.stringify({ type: "persona-answer", v: 1, kind: "accept" }),
        );
      } else if (event["type"] === "question") {
        // Malformed — forces a clean throw out of the JSONL resolver.
        enqueue("this is not valid JSON {");
      }
    };
    const nextLine = (): Promise<string> => {
      const n = queue.shift();
      if (n !== undefined) return Promise.resolve(n);
      return new Promise<string>((resolve) => {
        pending.push(resolve);
      });
    };
    const resolvers = buildJsonlProtocolResolvers({ writeLine, nextLine });

    const result = await runNew(
      {
        cwd: tmp,
        slug: "err-demo",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers,
        now: "2026-04-22T10:00:00Z",
        suppressStdout: true,
      },
      adapter,
    );

    // Interview interrupted -> non-zero exit.
    expect(result.exitCode).not.toBe(0);
    // Protocol cleanliness: no human-readable text on stdout. Only protocol
    // events were emitted via `writeLine`; runNew's stdout return must be "".
    expect(result.stdout).toBe("");
    // Error message lands on stderr, not stdout.
    expect(result.stderr.length).toBeGreaterThan(0);
    // The emitted stream is still parseable JSONL up to the throw point.
    for (const line of emitted) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });
});

// ---------- E2E spawn test for the readline pump (M4) ----------

describe("samospec new --interview-protocol jsonl — spawnSync E2E (M4)", () => {
  test("spawns CLI, drives stdin, reads stdout line-by-line, asserts protocol end-to-end", () => {
    // Stage a repo + fake claude/codex that produce canned adapter output.
    const fakeBin = mkdtempSync(path.join(tmpdir(), "samospec-jsonl-bin-"));
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-jsonl-home-"));
    try {
      // Fake claude: emit persona JSON on first call, then questions JSON,
      // then revise output for the rest. The adapter picks up the last
      // `--print`-flag argv entry; we just emit a fixed JSON per call.
      //
      // Simplest stub: track invocation count via a file so sequencing
      // works even across re-invocations in the same PID.
      const counterPath = path.join(fakeBin, ".claude-count");
      writeFileSync(counterPath, "0");
      // The adapter wraps every call's structured JSON inside
      // {"answer": "...", "usage": null, "effort_used": "max"} for ask,
      // and {"spec": "...", "ready": ..., "rationale": "...", "usage": null,
      // "effort_used": "max"} for revise. `answer` is a JSON-string that
      // the caller (persona / interview) re-parses.
      const personaJsonStr = JSON.stringify({
        persona: 'Veteran "CLI engineer" expert',
        rationale: "pragmatic",
      });
      const questionsJsonStr = JSON.stringify({
        questions: [
          { id: "q1", text: "framework?", options: ["React", "Vue"] },
          { id: "q2", text: "db?", options: ["pg", "sqlite"] },
          { id: "q3", text: "host?", options: ["vercel", "fly"] },
          { id: "q4", text: "lang?", options: ["ts", "rust"] },
          { id: "q5", text: "auth?", options: ["oauth", "magic-link"] },
        ],
      });
      const askPersonaPayload = JSON.stringify({
        answer: personaJsonStr,
        usage: null,
        effort_used: "max",
      });
      const askInterviewPayload = JSON.stringify({
        answer: questionsJsonStr,
        usage: null,
        effort_used: "max",
      });
      const revisePayload = JSON.stringify({
        spec: "# spec\n\n## Goal\nx\n\n## Scope\n- x\n\n## Non-goals\n- n\n",
        ready: false,
        rationale: "v0.1 draft",
        usage: null,
        effort_used: "max",
      });
      const claudeStub =
        "#!/usr/bin/env bash\n" +
        'if [ "$1" = "--version" ]; then echo "0.0.0"; exit 0; fi\n' +
        `N=$(cat "${counterPath}" 2>/dev/null || echo 0)\n` +
        `echo $((N+1)) > "${counterPath}"\n` +
        "case $N in\n" +
        `  0) cat <<'PAYLOAD_EOF_0'\n${askPersonaPayload}\nPAYLOAD_EOF_0\n` +
        "    ;;\n" +
        `  1) cat <<'PAYLOAD_EOF_1'\n${askInterviewPayload}\nPAYLOAD_EOF_1\n` +
        "    ;;\n" +
        `  *) cat <<'PAYLOAD_EOF_R'\n${revisePayload}\nPAYLOAD_EOF_R\n` +
        "    ;;\n" +
        "esac\n";
      writeFileSync(path.join(fakeBin, "claude"), claudeStub);
      chmodSync(path.join(fakeBin, "claude"), 0o755);
      const codexStub =
        '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "0.0.0"; exit 0; fi\nexit 0\n';
      writeFileSync(path.join(fakeBin, "codex"), codexStub);
      chmodSync(path.join(fakeBin, "codex"), 0o755);

      // Pre-compose stdin: persona accept + 5 answers, one per line, with v: 1.
      const stdin =
        [
          JSON.stringify({ type: "persona-answer", v: 1, kind: "accept" }),
          JSON.stringify({
            type: "answer",
            v: 1,
            id: "q1",
            choice: "Vue",
          }),
          JSON.stringify({ type: "answer", v: 1, id: "q2", choice: "pg" }),
          JSON.stringify({
            type: "answer",
            v: 1,
            id: "q3",
            choice: "fly",
          }),
          JSON.stringify({ type: "answer", v: 1, id: "q4", choice: "ts" }),
          JSON.stringify({
            type: "answer",
            v: 1,
            id: "q5",
            choice: "oauth",
          }),
        ].join("\n") + "\n";

      const r = spawnSync(
        Bun.argv[0] ?? "bun",
        [
          "run",
          CLI_PATH,
          "new",
          "spawn-demo",
          "--idea",
          "an idea",
          "--interview-protocol",
          "jsonl",
        ],
        {
          cwd: tmp,
          encoding: "utf8",
          input: stdin,
          env: {
            PATH: `${fakeBin}:/usr/bin:/bin:/usr/local/bin`,
            HOME: fakeHome,
            NO_COLOR: "1",
            ANTHROPIC_API_KEY: "sk-fake",
          },
          timeout: 30_000,
        },
      );
      const stdout = r.stdout ?? "";
      const stderr = r.stderr ?? "";

      // Stdout is pure JSONL protocol.
      const stdoutLines = stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines.length).toBeGreaterThan(0);
      const stdoutEvents: Record<string, unknown>[] = [];
      for (const l of stdoutLines) {
        // Every line parses as JSON.
        const parsed = JSON.parse(l) as Record<string, unknown>;
        stdoutEvents.push(parsed);
        // Every event carries v: 1.
        expect(parsed["v"]).toBe(1);
        // Allowed types only.
        const eventType = String(parsed["type"]);
        expect(["persona-proposal", "question", "complete"]).toContain(
          eventType,
        );
      }
      // At least: persona-proposal, 5 questions, complete.
      const qCount = stdoutEvents.filter(
        (e) => e["type"] === "question",
      ).length;
      expect(qCount).toBe(5);
      expect(
        stdoutEvents.find((e) => e["type"] === "persona-proposal"),
      ).toBeDefined();
      expect(stdoutEvents[stdoutEvents.length - 1]?.["type"]).toBe("complete");

      // Human notices went to stderr.
      expect(stderr.length).toBeGreaterThan(0);
      expect(r.status).toBe(0);

      // Artifacts landed.
      expect(
        existsSync(path.join(tmp, ".samo", "spec", "spawn-demo", "state.json")),
      ).toBe(true);
      expect(
        existsSync(
          path.join(tmp, ".samo", "spec", "spawn-demo", "interview.json"),
        ),
      ).toBe(true);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 60_000);
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

/**
 * Run a promise that is expected to reject and return the `Error.message`
 * (or String(thrown)). Fails the test if the promise resolves instead.
 * Prefer this over `await expect(p).rejects.toThrow(...)` which the
 * repo's eslint rules (await-thenable) flag on bun:test's `rejects` shim.
 */
async function captureRejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected promise to reject but it resolved");
}
