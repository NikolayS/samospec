// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

export interface FirstSprintSource {
  readonly slug: string;
  readonly specPath: string;
  readonly sourceRef: string;
  readonly repo: string;
}

export interface FirstSprintPlanInput {
  readonly specBody: string;
  readonly source: FirstSprintSource;
}

export interface PlannedFirstSprintIssue {
  readonly title: string;
  readonly body: string;
  readonly marker: string;
  readonly taskSlug: string;
  readonly labels: readonly string[];
}

export interface IssueCreateInput {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface IssueRef {
  readonly number: number;
  readonly url: string;
}

export interface SkippedDuplicateIssue extends IssueRef {
  readonly marker: string;
}

export interface CreatedFirstSprintIssue extends IssueRef {
  readonly marker: string;
  readonly title: string;
}

export interface FirstSprintIssueResult {
  readonly planned: readonly PlannedFirstSprintIssue[];
  readonly created: readonly CreatedFirstSprintIssue[];
  readonly skippedDuplicates: readonly SkippedDuplicateIssue[];
}

export interface IssueTracker {
  findByMarker(marker: string): Promise<IssueRef | null>;
  createIssue(input: IssueCreateInput): Promise<IssueRef>;
}

export async function createFirstSprintIssues(input: {
  readonly specBody: string;
  readonly source: FirstSprintSource;
  readonly tracker: IssueTracker;
  readonly dryRun: boolean;
}): Promise<FirstSprintIssueResult> {
  const planned = planFirstSprintIssues({
    specBody: input.specBody,
    source: input.source,
  });
  if (input.dryRun) {
    return { planned, created: [], skippedDuplicates: [] };
  }

  const created: CreatedFirstSprintIssue[] = [];
  const skippedDuplicates: SkippedDuplicateIssue[] = [];
  for (const issue of planned) {
    const existing = await input.tracker.findByMarker(issue.marker);
    if (existing !== null) {
      skippedDuplicates.push({ marker: issue.marker, ...existing });
      continue;
    }
    const ref = await input.tracker.createIssue({
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    created.push({ marker: issue.marker, title: issue.title, ...ref });
  }

  return { planned, created, skippedDuplicates };
}

export function planFirstSprintIssues(
  input: FirstSprintPlanInput,
): readonly PlannedFirstSprintIssue[] {
  const team = extractTeam(input.specBody);
  const firstSprint = extractFirstSprint(input.specBody);
  return firstSprint.tasks.map((task) => {
    const titleCore = titleFromTask(task.text);
    const taskSlug = slugify(titleCore);
    const marker = `samospec:first-sprint-task ${input.source.slug}:${taskSlug}`;
    const title = `[${input.source.slug}] Sprint 1: ${titleCore}`;
    return {
      title,
      taskSlug,
      marker,
      labels: ["samospec", "first-sprint"],
      body: buildIssueBody({
        source: input.source,
        marker,
        titleCore,
        originalTask: task.text,
        ownerHint: task.ownerHint,
        team,
        sprintHeading: firstSprint.heading,
      }),
    };
  });
}

export function formatFirstSprintDryRun(
  planned: readonly PlannedFirstSprintIssue[],
): string {
  const out = ["First sprint issues (dry run):", ""];
  for (const issue of planned) {
    out.push(`- ${issue.title}`);
  }
  out.push("");
  return out.join("\n");
}

interface SprintTask {
  readonly text: string;
  readonly ownerHint: string | null;
}

interface FirstSprintSection {
  readonly heading: string;
  readonly tasks: readonly SprintTask[];
}

function extractTeam(specBody: string): readonly string[] {
  const section = extractMarkdownSection(specBody, "team", 2);
  if (section === null) return [];
  return collectBulletBlocks(section.body).map((bullet) => {
    const role = /Veteran\s+"[^"]+"\s+expert/.exec(bullet);
    return role?.[0] ?? stripMarkdown(bullet);
  });
}

function extractFirstSprint(specBody: string): FirstSprintSection {
  const section = extractMarkdownSection(specBody, "implementation plan", 2);
  if (section === null) return { heading: "Sprint 1", tasks: [] };
  const sprint = extractFirstSprintSection(section.body);
  if (sprint === null) return { heading: "Sprint 1", tasks: [] };
  const tasks = collectBulletBlocks(sprint.body).map((bullet) => {
    const owner = /^\[([^\]]+)\]\s*/.exec(bullet);
    const text = owner === null ? bullet : bullet.slice(owner[0].length);
    return {
      text: stripMarkdown(text).replace(/\s+/g, " ").trim(),
      ownerHint: owner?.[1] ?? null,
    };
  });
  return { heading: sprint.heading, tasks };
}

function buildIssueBody(input: {
  readonly source: FirstSprintSource;
  readonly marker: string;
  readonly titleCore: string;
  readonly originalTask: string;
  readonly ownerHint: string | null;
  readonly team: readonly string[];
  readonly sprintHeading: string;
}): string {
  const out: string[] = [];
  out.push(`<!-- ${input.marker} -->`);
  out.push("");
  out.push(`# ${input.titleCore}`);
  out.push("");
  out.push("## Source");
  out.push("");
  out.push(
    `- Source: \`${input.source.specPath}\` at \`${input.source.sourceRef}\``,
  );
  out.push(`- Spec section: ${input.source.specPath}#implementation-plan`);
  out.push(`- Sprint: ${input.sprintHeading}`);
  out.push("");
  out.push("## Task");
  out.push("");
  out.push(`- ${input.originalTask}`);
  if (input.ownerHint !== null && input.ownerHint.length > 0) {
    out.push(`- Owner hint: ${input.ownerHint}`);
  }
  out.push("");
  out.push("## Team context");
  out.push("");
  if (input.team.length === 0) {
    out.push("- No Team section roles found in the accepted spec.");
  } else {
    for (const role of input.team) {
      out.push(`- ${role}`);
    }
  }
  out.push("");
  out.push("## Manager workflow contract");
  out.push("");
  out.push("- Start with red/green TDD for this task.");
  out.push("- Post intermediate progress in issue comments.");
  out.push("- Open a draft PR linked to this issue.");
  out.push("- Include test evidence in the PR body.");
  out.push("");
  return out.join("\n");
}

interface MarkdownSection {
  readonly heading: string;
  readonly body: string;
}

function extractMarkdownSection(
  markdown: string,
  wantedHeading: string,
  level: number,
): MarkdownSection | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const wanted = normalizeHeading(wantedHeading);
  let start = -1;
  let heading = "";
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseHeading(lines[i] ?? "");
    if (
      parsed !== null &&
      parsed.level === level &&
      normalizeHeading(parsed.text) === wanted
    ) {
      start = i + 1;
      heading = parsed.text;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const parsed = parseHeading(lines[i] ?? "");
    if (parsed !== null && parsed.level <= level) {
      end = i;
      break;
    }
  }
  return { heading, body: lines.slice(start, end).join("\n") };
}

function extractFirstSprintSection(markdown: string): MarkdownSection | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  let heading = "";
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseHeading(lines[i] ?? "");
    if (
      parsed !== null &&
      parsed.level === 3 &&
      /^Sprint\s+1\b/i.test(parsed.text)
    ) {
      start = i + 1;
      heading = parsed.text;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const parsed = parseHeading(lines[i] ?? "");
    if (parsed !== null && parsed.level <= 3) {
      end = i;
      break;
    }
  }
  return { heading, body: lines.slice(start, end).join("\n") };
}

function collectBulletBlocks(markdown: string): readonly string[] {
  const bullets: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet !== null) {
      if (current !== null) bullets.push(current.join(" "));
      current = [bullet[1] ?? ""];
      continue;
    }
    if (current !== null && /^\s{2,}\S/.test(line)) {
      current.push(line.trim());
      continue;
    }
    if (current !== null) {
      bullets.push(current.join(" "));
      current = null;
    }
  }
  if (current !== null) bullets.push(current.join(" "));
  return bullets.map((s) => s.replace(/\s+/g, " ").trim());
}

function parseHeading(
  line: string,
): { readonly level: number; readonly text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (match === null) return null;
  return { level: match[1]?.length ?? 0, text: match[2] ?? "" };
}

function normalizeHeading(s: string): string {
  return stripMarkdown(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function titleFromTask(task: string): string {
  const stripped = stripMarkdown(task).replace(/\s+/g, " ").trim();
  const split = /\s+(?:into|and skip|for)\s+/i.exec(stripped);
  const core = split === null ? stripped : stripped.slice(0, split.index);
  return core.replace(/[.。]\s*$/, "");
}

function stripMarkdown(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface GhRunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GhRunner = (argv: readonly string[]) => GhRunResult;

export class GhIssueAdapter implements IssueTracker {
  private readonly repo: string;
  private readonly run: GhRunner;

  constructor(opts: { readonly repo: string; readonly run?: GhRunner }) {
    this.repo = opts.repo;
    this.run = opts.run ?? defaultGhRunner;
  }

  findByMarker(marker: string): Promise<IssueRef | null> {
    const res = this.run([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--search",
      marker,
      "--json",
      "number,url",
      "--state",
      "all",
      "--limit",
      "1",
    ]);
    if (res.status !== 0) {
      throw new Error(`gh issue list failed: ${res.stderr || res.stdout}`);
    }
    const parsed = parseIssueList(res.stdout);
    return Promise.resolve(parsed[0] ?? null);
  }

  createIssue(input: IssueCreateInput): Promise<IssueRef> {
    const argv = [
      "issue",
      "create",
      "--repo",
      this.repo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.labels.length > 0) {
      argv.push("--label", input.labels.join(","));
    }
    const res = this.run(argv);
    if (res.status !== 0) {
      throw new Error(`gh issue create failed: ${res.stderr || res.stdout}`);
    }
    const url = extractFirstUrl(res.stdout);
    if (url === null) {
      throw new Error("gh issue create did not print an issue URL");
    }
    const number = issueNumberFromUrl(url);
    if (number === null) {
      throw new Error(`gh issue create printed an unrecognized URL: ${url}`);
    }
    return Promise.resolve({ number, url });
  }
}

function defaultGhRunner(argv: readonly string[]): GhRunResult {
  const res = spawnSync("gh", argv as string[], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function parseIssueList(stdout: string): readonly IssueRef[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh issue list returned non-array JSON");
  }
  const issues: IssueRef[] = [];
  for (const item of parsed) {
    if (!isIssueRef(item)) continue;
    issues.push(item);
  }
  return issues;
}

function isIssueRef(value: unknown): value is IssueRef {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as { readonly number?: unknown; readonly url?: unknown };
  return typeof obj.number === "number" && typeof obj.url === "string";
}

function extractFirstUrl(stdout: string): string | null {
  const match = /https?:\/\/\S+/.exec(stdout);
  return match?.[0] ?? null;
}

function issueNumberFromUrl(url: string): number | null {
  const match = /\/issues\/(\d+)(?:\D*)?$/.exec(url);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}
