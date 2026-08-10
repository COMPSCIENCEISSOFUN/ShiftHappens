/**
 * Export the workforce report (Boundary Layer)
 *
 * The only control in the product that reaches
 * `GET /api/organizations/[orgId]/reports/export`.
 *
 * That route was written in July — authenticated, suspension-checked,
 * permission-gated, plan-gated, department-scoped and tested — and nothing has
 * ever called it. There is no reports page. So the pricing table has been
 * selling "PDF report export" as a Pro feature that could not be reached from
 * anywhere in the application, which is the same claim-outruns-behaviour shape
 * as the alerts that wore an "AI Insight" badge over a SQL join.
 *
 * ## Why it disappears instead of refusing
 *
 * Two independent gates, both answered before anything is offered, and both can
 * only deny: absent without `reports:export`, absent on a plan without
 * `pdf_export`. Neither costs a request — the permissions and the tier both come
 * from the `(app)` shell's providers, which the layout resolved server-side — so
 * there is no flicker and no 403 to explain.
 *
 * HIDDEN rather than greyed with an upgrade badge, which is the opposite of the
 * house answer for a plan-gated *checkbox* and deliberately so. The precedent
 * here is Import Members: a Pro-only control on a page a Free organisation can
 * open, and it is simply not rendered. A greyed button is still an offer, and
 * the menu rule — do not offer what cannot be done — applies to page controls
 * for the same reason it applies to the sidebar.
 *
 * ## Why this fetches rather than being a link
 *
 * An `<a download>` would be shorter and wrong in three ways. A refusal would
 * navigate the manager away from their dashboard to a page of raw JSON; there
 * would be no way to disable it while the PDF is building, so an impatient
 * second click bills a second render of a document that takes seconds; and the
 * server's filename, which carries the date, would still have to be duplicated
 * here to be used. Reading the response lets all three be handled where they
 * happen.
 */
"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";

/**
 * The filename the server chose, or a plain fallback.
 *
 * The route already names the file with the date it was generated, and that is
 * the name worth keeping: a folder of `workforce-report.pdf (3)` tells nobody
 * which week they are looking at. Parsed rather than rebuilt so the two cannot
 * drift — the fallback exists only for a response that omits the header, not as
 * a second source of truth.
 */
export function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match ? match[1] : "workforce-report.pdf";
}

type State = "idle" | "working" | "failed";

export function ExportReportButton({ orgId }: { orgId: string }) {
  const { can } = usePermissions();
  const { has } = usePlan();
  const [state, setState] = useState<State>("idle");

  // After the hooks, never before — an early return above `useState` would
  // change the hook count between renders the moment a plan or a permission
  // arrives.
  if (!can("reports:export")) return null;
  if (!has("pdf_export")) return null;

  async function download() {
    setState("working");
    try {
      const res = await fetch(`/api/organizations/${orgId}/reports/export`);
      if (!res.ok) {
        setState("failed");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(
        res.headers.get("Content-Disposition")
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      setState("idle");
    } catch {
      // Offline, or the response was not a document. Reported rather than
      // swallowed: a button that appears to do nothing gets pressed again.
      setState("failed");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {state === "failed" && (
        <span className="text-xs text-red-600 dark:text-red-400">
          Couldn&apos;t build the report.
        </span>
      )}
      <button
        type="button"
        onClick={download}
        disabled={state === "working"}
        className={SECONDARY_BUTTON}
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        {state === "working"
          ? "Building…"
          : state === "failed"
            ? "Try again"
            : "Export PDF"}
      </button>
    </div>
  );
}
