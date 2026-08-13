"use client";

/**
 * The smart engine, on the screen it was measured for.
 *
 * `GET /api/organizations/[orgId]/reports/engine` backs five panels that only
 * the admin dashboard ever rendered. Rather than re-typing them here, this card
 * is a wrapper: the panels are unchanged and keep their own frames, and what
 * moves is only WHO gets to see them — the registry gates this on
 * `reports:view` and an unrestricted scope, so a custom role granted reporting
 * across the whole organisation now reaches it too.
 *
 * ## Why it renders nothing rather than a failure
 *
 * Unlike the dashboard sections, this is one extra request against a separate
 * route and the page is complete without it. A dashboard that shows an error
 * strip because an optional panel timed out is worse than one that is a little
 * shorter. The section either appears or does not.
 *
 * The 30-day window is fixed rather than a control, because nothing on this
 * page reads a window and a picker that only one card obeys is a picker that
 * lies about the rest.
 */
import { useEffect, useState } from "react";

import type { CoverageCell } from "@/components/charts/chart-primitives";
import {
  AllocationEnginePanel,
  CoveragePanel,
  EligibilityEnginePanel,
  type AllocationEngineStats,
  type EligibilityEngineStats,
} from "@/components/dashboard/engine-panels";
import {
  ResponsePanel,
  SatisfactionPanel,
  type ResponseStats,
  type SatisfactionStats,
} from "@/components/dashboard/feedback-panels";

const WINDOW_DAYS = 30;

/** Payload of GET /api/organizations/[orgId]/reports/engine. */
interface EngineReport {
  allocation: AllocationEngineStats;
  eligibility: EligibilityEngineStats;
  coverage: CoverageCell[];
  response: ResponseStats;
  satisfaction: SatisfactionStats;
}

export function EngineCard({ orgId }: { orgId: string }) {
  const [report, setReport] = useState<EngineReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/organizations/${orgId}/reports/engine?days=${WINDOW_DAYS}`
        );
        const body = await response.json().catch(() => null);
        /*
         * `allocation` and not `response.ok` alone. This route gained fields
         * after it shipped, and an older or cached body can arrive without
         * them; the panels below index into `allocation` unguarded, so an
         * incomplete payload must be treated as no payload.
         */
        if (!cancelled && response.ok && body?.allocation) setReport(body);
      } catch {
        // The section simply does not appear — see the header.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!report) return null;

  return (
    <div className="space-y-4 md:col-span-2">
      <div className="grid gap-4 lg:grid-cols-2">
        <AllocationEnginePanel stats={report.allocation} />
        <EligibilityEnginePanel stats={report.eligibility} />
      </div>
      {/*
        Response and satisfaction sit beside the engine panels and carry no
        engine mark, because no engine produced them — they are recorded fact
        about what people did and said. Guarded individually for the reason
        above: two of these five fields arrived later than the other three.
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        {report.response && <ResponsePanel stats={report.response} />}
        {report.satisfaction && <SatisfactionPanel stats={report.satisfaction} />}
      </div>
      <CoveragePanel cells={report.coverage} />
    </div>
  );
}
