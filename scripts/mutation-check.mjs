/**
 * Mutation check — breaks the code on purpose and confirms the right test notices.
 *
 * ## Why this exists
 *
 * A passing test proves that its assertions hold. It does not prove they CAN
 * fail. This project has found thirteen tests that passed while testing
 * nothing — several that could not fail under any input, one that pinned a bug
 * rather than catching it, and one that was the only thing in the codebase ever
 * writing the field it checked.
 *
 * The answer has always been to break the code by hand and watch for red. That
 * works and it does not scale: sixteen checks across six files is half an hour
 * of careful editing, and the step everyone skips is putting the line back.
 *
 * ## What it does
 *
 * For each mutation: replace an exact string in a source file, run ONLY the test
 * file that should care, and record whether the expected test failed. Then put
 * the file back — every time, in a `finally`, whether the run passed, failed or
 * threw.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   KILLED    the expected test failed. The test does its job.
 *   SURVIVED  nothing failed. The test cannot catch this bug — a finding.
 *   MISFIRED  something failed, but not the test named. Usually a compile
 *             error from the mutation itself, meaning the mutation is wrong
 *             rather than the test.
 *
 * ## Safety
 *
 * Originals are copied to `.mutation-backup/` before anything is touched, and
 * every file is compared byte-for-byte at the end. If a restore ever fails the
 * script says so loudly and names the backup — because at the time of writing
 * none of this work was committed, so a botched restore would not have been
 * recoverable from git.
 *
 * Run:  node scripts/mutation-check.mjs
 *       node scripts/mutation-check.mjs withdraw plan     (substring filter)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";

const BACKUP_DIR = ".mutation-backup";

/**
 * Each entry names the smallest edit that should break exactly one behaviour.
 *
 * `expect` is matched against the run's output, so a mutation that merely
 * breaks the build is not mistaken for a test doing its job — the failure has
 * to be the named test.
 */
const MUTATIONS = [
  {
    id: "withdraw-deletes-the-row",
    why: "The kept row is the only thing stopping the engine offering the shift back to whoever just withdrew.",
    file: "src/repositories/task-assignment.repository.ts",
    find: `  async withdraw(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "withdrawn" },
    });
  }`,
    replace: `  async withdraw(id: string) {
    return prisma.taskAssignment.delete({ where: { id } });
  }`,
    test: "tests/services/shift-cover.test.ts",
    expect: [
      "keeps the assignment row, marked withdrawn",
      "leaves them out of the cover options afterwards",
    ],
  },
  {
    id: "plan-gate-unmapped",
    why: "Without the mapping the plan is consulted after the permission, and a Free caller is told Forbidden.",
    file: "src/lib/permissions.ts",
    find: `  "reports:export": "pdf_export",\n`,
    replace: "",
    test: "tests/lib/permissions.test.ts tests/api/reports-export.test.ts",
    expect: ["gates the PDF export on the plan that sells it"],
  },
  {
    id: "export-scope-dropped",
    why: "A manager would download the whole company's staff hours in a file they keep.",
    file: "src/app/api/organizations/[orgId]/reports/export/route.ts",
    find: `      departmentScopeFor(membership),
      user.id`,
    replace: `      null,
      user.id`,
    test: "tests/api/reports-export.test.ts",
    expect: ["scopes a manager's report to their own departments"],
  },
  {
    id: "double-click-unguarded",
    why: "Two presses would render the PDF twice.",
    file: "src/components/dashboard/export-report-button.tsx",
    find: `        disabled={state === "working"}\n`,
    replace: "",
    test: "tests/components/export-report-button.test.tsx",
    expect: ["does not build a second report while the first is still going"],
  },
  {
    id: "plan-gate-not-checked-in-ui",
    why: "The button would appear on a plan that cannot use it.",
    file: "src/components/dashboard/export-report-button.tsx",
    find: `  if (!has("pdf_export")) return null;\n`,
    replace: "",
    test: "tests/components/export-report-button.test.tsx",
    expect: ["offers nothing on a plan without pdf_export"],
  },
  {
    id: "permission-not-checked-in-ui",
    why: "The button would appear for somebody who cannot use it.",
    file: "src/components/dashboard/export-report-button.tsx",
    find: `  if (!can("reports:export")) return null;\n`,
    replace: "",
    test: "tests/components/export-report-button.test.tsx",
    expect: ["offers nothing to a member without reports:export"],
  },
  {
    id: "failure-reported-as-idle",
    why: "A refusal would look like nothing happened, and get pressed again.",
    file: "src/components/dashboard/export-report-button.tsx",
    find: `      if (!res.ok) {
        setState("failed");
        return;
      }`,
    replace: `      if (!res.ok) {
        setState("idle");
        return;
      }`,
    test: "tests/components/export-report-button.test.tsx",
    expect: ["says so when the report cannot be built"],
  },
  {
    id: "filename-always-fallback",
    why: "Every download would be workforce-report.pdf and nobody could tell which week.",
    file: "src/components/dashboard/export-report-button.tsx",
    find: `  return match ? match[1] : "workforce-report.pdf";`,
    replace: `  return "workforce-report.pdf";`,
    test: "tests/components/export-report-button.test.tsx",
    expect: ["takes the name the server chose"],
  },
  {
    id: "withdrawal-seeks-no-cover",
    why: "The slot would empty and nothing would look for a replacement.",
    file: "src/services/task-assignment.service.ts",
    find: `      await this.seekCover(assignment, actorUserId);

      /*
       * The row, not a hand-built object.`,
    replace: `      /*
       * The row, not a hand-built object.`,
    test: "tests/services/shift-cover.test.ts",
    expect: ["offers the shift to the best replacement in auto mode"],
  },
  {
    id: "stale-shift-not-guarded",
    why: "Resolving a months-old request would tell the whole team to arrange cover for a shift already worked.",
    file: "src/services/task-assignment.service.ts",
    find: `    const over = assignment.task.scheduledEnd ?? assignment.task.scheduledStart;
    if (over && over.getTime() < Date.now()) return;`,
    replace: "",
    test: "tests/services/shift-cover.test.ts",
    expect: ["does not look for cover for a shift that has already ended"],
  },
  {
    id: "cron-calls-a-provider",
    why: "One AI call per unfilled shift per hour per tenant, on a schedule nobody set.",
    file: "src/services/recurring-task.service.ts",
    find: `            { useAI: false }`,
    replace: `            { useAI: true }`,
    test: "tests/services/recurring-auto-fill.test.ts",
    expect: ["never asks a provider"],
  },
  {
    id: "sweep-ignores-short-notice",
    why: "A background job would put somebody on tomorrow's rota without warning.",
    file: "src/services/allocation.service.ts",
    find: `const SHORT_NOTICE_MS = 48 * 60 * 60 * 1000;`,
    replace: `const SHORT_NOTICE_MS = 0;`,
    test: "tests/services/auto-staffing-retry.test.ts",
    expect: ["will not fill a shift starting tomorrow"],
  },
];

// ── file helpers, CRLF-preserving ────────────────────────────────────────────

function readText(file) {
  const raw = readFileSync(file);
  const crlf = raw.includes("\r\n");
  return { crlf, text: raw.toString("utf8").replace(/\r\n/g, "\n") };
}

function writeText(file, text, crlf) {
  writeFileSync(file, Buffer.from(crlf ? text.replace(/\n/g, "\r\n") : text, "utf8"));
}

function backupPath(file) {
  return join(BACKUP_DIR, file.replace(/[\\/\[\]]/g, "_"));
}

// ── pre-flight ───────────────────────────────────────────────────────────────

const filter = process.argv.slice(2);
const selected = filter.length
  ? MUTATIONS.filter((m) => filter.some((f) => m.id.includes(f)))
  : MUTATIONS;

if (selected.length === 0) {
  console.error(`No mutation matched ${filter.join(", ")}`);
  process.exit(1);
}

/*
 * Every target is verified BEFORE anything is written.
 *
 * A find-string that no longer matches means the source has moved on and the
 * mutation is describing code that is not there — which would otherwise show up
 * as a "SURVIVED" and be read as a hole in the tests rather than a stale
 * script. It is also the guard against a previous crashed run having left a
 * mutation in place.
 */
const problems = [];
for (const m of selected) {
  if (!existsSync(m.file)) {
    problems.push(`${m.id}: ${m.file} does not exist`);
    continue;
  }
  const { text } = readText(m.file);
  const n = text.split(m.find).length - 1;
  if (n !== 1) problems.push(`${m.id}: target matched ${n} times in ${m.file} (want exactly 1)`);
}
if (problems.length) {
  console.error("Refusing to run — the script no longer describes the code:\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const originals = new Map();
for (const m of selected) {
  if (!originals.has(m.file)) {
    const raw = readFileSync(m.file);
    originals.set(m.file, raw);
    writeFileSync(backupPath(m.file), raw);
  }
}

// Put everything back even on Ctrl+C.
function restoreAll() {
  for (const [file, raw] of originals) writeFileSync(file, raw);
}
process.on("SIGINT", () => {
  restoreAll();
  console.error("\nInterrupted — all files restored.");
  process.exit(130);
});

// ── run ──────────────────────────────────────────────────────────────────────

const results = [];

for (const [i, m] of selected.entries()) {
  process.stdout.write(`\n[${i + 1}/${selected.length}] ${m.id}\n  ${m.why}\n  breaking ${basename(m.file)} → ${m.test}\n`);

  const { crlf, text } = readText(m.file);
  let verdict = "ERROR";
  let detail = "";

  try {
    writeText(m.file, text.replace(m.find, m.replace), crlf);

    const run = spawnSync(`npx vitest run ${m.test}`, {
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

    const found = m.expect.filter((e) => output.includes(e));

    if (run.status === 0) {
      verdict = "SURVIVED";
      detail = "the suite stayed green with the code broken";
    } else if (found.length === m.expect.length) {
      verdict = "KILLED";
      detail = m.expect.length > 1 ? `all ${m.expect.length} expected tests failed` : "";
    } else if (found.length > 0) {
      verdict = "PARTIAL";
      detail = `only ${found.length}/${m.expect.length} expected tests failed — missing: ${m.expect.filter((e) => !found.includes(e)).join("; ")}`;
    } else {
      verdict = "MISFIRED";
      detail = "something failed, but not the expected test — the mutation may not compile";
    }
  } catch (error) {
    detail = String(error);
  } finally {
    // Always, whatever happened above.
    writeFileSync(m.file, originals.get(m.file));
  }

  console.log(`  → ${verdict}${detail ? " — " + detail : ""}`);
  results.push({ ...m, verdict, detail });
}

// ── restore check ────────────────────────────────────────────────────────────

const notRestored = [];
for (const [file, raw] of originals) {
  if (!readFileSync(file).equals(raw)) notRestored.push(file);
}

// ── report ───────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
for (const r of results) {
  console.log(`${r.verdict.padEnd(9)} ${r.id}`);
}

const killed = results.filter((r) => r.verdict === "KILLED").length;
const bad = results.filter((r) => r.verdict !== "KILLED");

console.log("=".repeat(70));
console.log(`${killed}/${results.length} mutations killed`);

if (bad.length) {
  console.log("\nWorth reading — each of these is a test that did not do its job:\n");
  for (const r of bad) {
    console.log(`  ${r.verdict}  ${r.id}`);
    console.log(`     ${r.detail}`);
    console.log(`     would have meant: ${r.why}\n`);
  }
}

if (notRestored.length) {
  console.error("\n!!! FILES NOT RESTORED — originals are in " + BACKUP_DIR + ":");
  for (const f of notRestored) console.error("  " + f);
  process.exit(2);
}

console.log("\nAll files restored to their original bytes.");
process.exit(bad.length ? 1 : 0);
