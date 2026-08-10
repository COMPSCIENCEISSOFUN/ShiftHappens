/**
 * A shell that knows which organisation it is rendering must say which plan.
 *
 * ## The bug
 *
 * `AppShell` takes `tier` as OPTIONAL and defaults it to "free". That default
 * is correct and deliberate — the org-agnostic branch of `DefaultOrgShell`
 * renders before any organisation exists, and the restricted end is the safe
 * answer when there is no plan to report.
 *
 * `DefaultOrgShell` then omitted it on the branch that HAS an organisation. So
 * every page using that chrome — the dashboard, onboarding, the profile —
 * believed every organisation was on Free, while `/org/[orgId]`, whose layout
 * does pass it, believed the truth. The sidebar dropped Roles and Audit Log on
 * the dashboard and restored them one navigation later: two menus for one
 * organisation, decided by which page you were standing on.
 *
 * Nothing failed loudly, because until the dashboard carried a plan-gated
 * control of its own there was nothing on those pages for a wrong tier to hide.
 * The Export PDF button was the first, and it never appeared.
 *
 * ## Why a scan and not just the fix
 *
 * Same reasoning as `no-inline-icons` and `ordering-determinism`: the defect is
 * the natural thing to type. An optional prop that defaults to the safe value
 * is silent when forgotten — nothing errors, nothing renders wrong, a plan is
 * simply understated. A third shell added later would omit it exactly as
 * easily, and the symptom would again be a control that is missing rather than
 * a page that breaks.
 *
 * ## Why the TypeScript parser rather than a string search
 *
 * Both files that mount `AppShell` discuss the plan at length in comments. A
 * `text.includes("tier")` check passes on a file where the only mention is the
 * comment explaining what went wrong, which is the exact state this file exists
 * to catch — the check would have gone green on the broken code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(process.cwd(), "src");

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFilesUnder(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Mount {
  file: string;
  line: number;
  attributes: string[];
}

/** Every `<AppShell …>` in the codebase, with the names of its props. */
function appShellMounts(): Mount[] {
  const mounts: Mount[] = [];

  for (const file of tsxFilesUnder(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("<AppShell")) continue;

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const visit = (node: ts.Node) => {
      const opening = ts.isJsxOpeningElement(node)
        ? node
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;

      if (opening && opening.tagName.getText(source) === "AppShell") {
        mounts.push({
          file: file.replace(process.cwd(), "").replace(/\\/g, "/"),
          line:
            source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1,
          attributes: opening.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => attribute.name.getText(source)),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return mounts;
}

describe("every AppShell that names an organisation names its plan", () => {
  /*
   * Asserted first, and separately. If a refactor renamed the component or
   * moved these files, every expectation below would pass over an empty list —
   * a green suite proving nothing, which is the failure mode this project has
   * found twelve times.
   */
  it("finds the mounts at all", () => {
    expect(appShellMounts().length).toBeGreaterThanOrEqual(2);
  });

  it("passes tier wherever it passes orgId", () => {
    for (const mount of appShellMounts()) {
      if (!mount.attributes.includes("orgId")) continue;

      expect(
        mount.attributes,
        `${mount.file}:${mount.line} mounts AppShell with an organisation but no tier, ` +
          `so every plan gate on that page will read as Free`
      ).toContain("tier");
    }
  });

  /*
   * The other direction, stated so the default is not mistaken for an
   * oversight. A shell with no organisation has no plan to report, and Free is
   * the restricted end — that mount is correct as it stands, and somebody
   * "fixing" it by inventing a tier would be guessing.
   */
  it("leaves the org-less mount alone", () => {
    const orgless = appShellMounts().filter(
      (mount) => !mount.attributes.includes("orgId")
    );

    expect(orgless.length).toBeGreaterThanOrEqual(1);
    for (const mount of orgless) {
      expect(mount.attributes).not.toContain("tier");
    }
  });
});
