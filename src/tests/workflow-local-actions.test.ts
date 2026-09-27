// =============================================================================
// GENHUB - A workflow that calls a LOCAL action has to check the repo out first
//
// Why this exists. `.github/actions/supervise` is a local composite action, and
// a local action is resolved from the RUNNER'S WORKSPACE — which is empty until
// `actions/checkout` fills it. Six workflows call it. None of them checked out,
// so every scheduled run of all six failed in under a second, before a single
// request was made, with:
//
//   Can't find 'action.yml', 'action.yaml' or 'Dockerfile' under
//   '.../.github/actions/supervise'. Did you forget to run actions/checkout
//   before running your local action?
//
// The damage was not "a broken job". /api/health read `backgroundJobs: never`
// for days, the heartbeat said no worker had ever run, the uptime watchdog was
// permanently red on a deployment where nothing was actually wrong, and the one
// alarm that was telling the truth stopped being read. Nothing in the app, the
// type checker or the rest of this suite could see it: the defect lives in YAML,
// which no other gate parses.
//
// So this file parses it. The first case is a LIVE GUARD on the real workflows
// and fails the moment a new caller forgets the checkout. The rest pin the
// checks on inputs built here, because a gate that can only ever agree is not a
// gate.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = join(".github", "workflows");
const ACTIONS_DIR = join(".github", "actions");

interface Located {
  /** 1-indexed line in the file the step is on. */
  line: number;
  /** The raw `uses:` value. */
  uses: string;
}

interface Workflow {
  file: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Parsing
//
// Line-based and deliberately narrow: it reads the two things this rule needs —
// where each job starts and what each step `uses` — rather than modelling YAML.
// A parser that understood everything would be a dependency (the project has no
// YAML library) and a second thing to get wrong, and no rule in this file cares
// about anything else in the file.
// ---------------------------------------------------------------------------

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
}

function readWorkflow(file: string): Workflow {
  return { file, source: readFileSync(join(WORKFLOWS_DIR, file), "utf8") };
}

/** Every `uses:` in the file, in order, with its line number. */
function allUses(source: string): Located[] {
  const found: Located[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    // `- uses: x` and `uses: x` are the two shapes a step is written in.
    const match = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/.exec(text);
    if (match) found.push({ line: index + 1, uses: match[1] });
  });
  return found;
}

/**
 * The `uses:` entries that point at THIS repository.
 *
 * `./…` is the local form; `owner/repo@ref` and `docker://…` are resolved by
 * GitHub itself and work with an empty workspace, so they are not this rule's
 * business.
 */
function localUses(source: string): Located[] {
  return allUses(source).filter((entry) => entry.uses.startsWith("./"));
}

/**
 * The line numbers each job's `steps:` covers, so a checkout in one job cannot
 * vouch for a local action in another.
 */
function jobRanges(source: string): { name: string; start: number; end: number }[] {
  const lines = source.split(/\r?\n/);
  const jobsAt = lines.findIndex((text) => /^jobs:\s*$/.test(text));
  if (jobsAt === -1) return [];

  const starts: { name: string; line: number }[] = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    // A job key sits at two spaces: `  reconcile:`
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (match) starts.push({ name: match[1], line: i + 1 });
    // Anything at column zero ends the whole `jobs:` block.
    if (i > jobsAt + 1 && /^\S/.test(lines[i])) break;
  }

  return starts.map((job, index) => ({
    name: job.name,
    start: job.line,
    end: index + 1 < starts.length ? starts[index + 1].line - 1 : lines.length,
  }));
}

interface Violation {
  /** Workflow file, relative to the repository root. */
  file: string;
  job: string;
  line: number;
  uses: string;
  reason: "no-checkout" | "missing-action";
}

/**
 * Everything wrong with one workflow's local-action usage, in the order the
 * file would reach it.
 *
 * Two rules:
 *   1. a `./…` use must come after an `actions/checkout` in the SAME job — the
 *      one GitHub enforces, and the one that was silently broken here;
 *   2. the directory it names must actually hold an `action.yml`, because a
 *      typo'd path produces the identical error message and would otherwise
 *      look like the same bug coming back.
 */
function localActionViolations(
  file: string,
  source: string,
  actionExists: (uses: string) => boolean = () => true
): Violation[] {
  const uses = allUses(source);
  const violations: Violation[] = [];

  for (const job of jobRanges(source)) {
    const inJob = uses.filter((entry) => entry.line >= job.start && entry.line <= job.end);

    for (const entry of inJob) {
      if (!entry.uses.startsWith("./")) continue;

      const checkedOut = inJob.some(
        (other) =>
          other.line < entry.line &&
          (other.uses === "actions/checkout" || other.uses.startsWith("actions/checkout@"))
      );
      if (!checkedOut) {
        violations.push({
          file,
          job: job.name,
          line: entry.line,
          uses: entry.uses,
          reason: "no-checkout",
        });
      }

      if (!actionExists(entry.uses)) {
        violations.push({
          file,
          job: job.name,
          line: entry.line,
          uses: entry.uses,
          reason: "missing-action",
        });
      }
    }
  }

  return violations;
}

/** Does the path a local `uses:` names hold a runnable action definition? */
function actionDefinitionExists(uses: string): boolean {
  const dir = uses.replace(/^\.\//, "");
  return (
    existsSync(join(dir, "action.yml")) ||
    existsSync(join(dir, "action.yaml")) ||
    existsSync(join(dir, "Dockerfile"))
  );
}

const workflows = workflowFiles().map(readWorkflow);

// ---------------------------------------------------------------------------

describe("workflow local actions", () => {
  // ---------------------------------------------------------------------------
  // 1. The real workflows — a live guard, not a fixture
  // ---------------------------------------------------------------------------
  it("checks the repository out in every job that calls a local action", () => {
    const violations = workflows.flatMap((workflow) =>
      localActionViolations(workflow.file, workflow.source, actionDefinitionExists)
    );

    expect(
      violations.map(
        (v) =>
          `${v.file}:${v.line} (job ${v.job}) ${
            v.reason === "no-checkout" ? "never checks out the repo" : "has no action.yml"
          } before \`uses: ${v.uses}\``
      )
    ).toEqual([]);
  });

  it("has a local action to guard at all", () => {
    // Guards the guard: if the `./…` form ever stops appearing, the case above
    // would pass while checking nothing.
    const callers = workflows.filter((workflow) => localUses(workflow.source).length > 0);
    expect(callers.length).toBeGreaterThanOrEqual(6);
    expect(readdirSync(ACTIONS_DIR).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. The behaviour, on inputs built here — so the guard can actually fail
  // ---------------------------------------------------------------------------
  it("catches a local action called from a job that never checked out", () => {
    const broken = [
      "name: Broken",
      "on:",
      "  workflow_dispatch: {}",
      "jobs:",
      "  poll:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Call the endpoint",
      "        run: curl -fsS https://example.com",
      "      - uses: ./.github/actions/supervise",
    ].join("\n");

    const violations = localActionViolations("broken.yml", broken);

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("no-checkout");
    expect(violations[0].job).toBe("poll");
    // The message has to name the file and the line, because that is where the
    // fix goes.
    expect(violations[0].line).toBe(10);
    expect(violations[0].uses).toBe("./.github/actions/supervise");
  });

  it("accepts the same workflow once the checkout is added", () => {
    const fixed = [
      "name: Fixed",
      "on:",
      "  workflow_dispatch: {}",
      "jobs:",
      "  poll:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Call the endpoint",
      "        run: curl -fsS https://example.com",
      "      - uses: actions/checkout@v4",
      "      - uses: ./.github/actions/supervise",
    ].join("\n");

    expect(localActionViolations("fixed.yml", fixed)).toEqual([]);
  });

  it("does not accept a checkout that comes after the local action", () => {
    // The order is the whole rule: a checkout below the `uses:` line runs too
    // late to put action.yml in the workspace.
    const tooLate = [
      "jobs:",
      "  poll:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/supervise",
      "      - uses: actions/checkout@v4",
    ].join("\n");

    const violations = localActionViolations("late.yml", tooLate);
    expect(violations.map((v) => v.reason)).toEqual(["no-checkout"]);
  });

  it("does not demand a checkout for a remote action or a docker image", () => {
    // GitHub resolves these itself. Requiring a checkout for them would flag
    // every ordinary workflow and make the real signal unreadable.
    const remote = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "      - uses: docker://alpine:3",
    ].join("\n");

    expect(localActionViolations("remote.yml", remote)).toEqual([]);
  });

  it("does not let one job's checkout vouch for another job's local action", () => {
    const twoJobs = [
      "jobs:",
      "  has-checkout:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "  forgets:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/supervise",
    ].join("\n");

    const violations = localActionViolations("two-jobs.yml", twoJobs);
    expect(violations).toHaveLength(1);
    expect(violations[0].job).toBe("forgets");
  });

  it("catches a local action whose directory holds no action.yml", () => {
    const typo = [
      "jobs:",
      "  poll:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: ./.github/actions/supervize",
    ].join("\n");

    // The default existence check is what the live guard uses; this passes a
    // stub so the missing-action branch can be exercised without touching disk.
    const violations = localActionViolations("typo.yml", typo, () => false);
    expect(violations.map((v) => v.reason)).toEqual(["missing-action"]);
  });
});
