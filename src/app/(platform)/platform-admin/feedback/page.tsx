/**
 * Platform Admin — Feedback Queue (Boundary Layer)
 *
 * Every tenant's product feedback, newest first. The one screen in the
 * application whose question has no organisation in it.
 *
 * ## Counting, not guessing
 *
 * The area chips carry exact counts from SQL, because the sender picked the
 * area. That is the whole reason the list is closed rather than free text: an
 * exact answer, one query, available the moment the first message arrives.
 *
 * ## Archiving is housekeeping
 *
 * It is invisible to the sender and reversible here. A queue nobody dares tidy
 * stops being read, and "cleared" must not come to mean "judged".
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, Inbox, MessagesSquare } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  FEEDBACK_AREAS,
  FEEDBACK_AREA_LABEL,
  isFeedbackArea,
  type FeedbackArea,
} from "@/lib/feedback-areas";

interface FeedbackRow {
  id: string;
  area: string;
  message: string;
  createdAt: string;
  archivedAt: string | null;
  organization: { id: string; name: string };
  membership: {
    id: string;
    role: string;
    user: { id: string; name: string | null; email: string };
  };
}

interface QueueResponse {
  rows: FeedbackRow[];
  total: number;
  page: number;
  pageSize: number;
  areas: { counts: { area: string; count: number }[]; windowDays: number; total: number };
}

export default function PlatformFeedbackPage() {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<FeedbackArea | "">("");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (area) query.set("area", area);
      if (showArchived) query.set("archived", "1");
      if (page > 0) query.set("page", String(page));

      const response = await fetch(`/api/platform/feedback?${query.toString()}`);
      if (!response.ok) {
        // An empty list and a failed load must not look the same.
        setError("Could not load feedback. Refresh to try again.");
        setData(null);
        return;
      }
      const body: QueueResponse = await response.json();
      setError(null);
      setData(body);
      /*
       * The server clamps the page to one that exists, so follow it.
       *
       * Without this, archiving the only row on the last page leaves this
       * screen asking for a page that is now past the end: the list renders
       * the empty state, and the pager hides itself because the total no
       * longer exceeds one page — so the remaining messages are unreachable
       * without a reload.
       */
      if (body.page !== page) setPage(body.page);
    } catch {
      setError("Could not reach the server.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [area, showArchived, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads this page's rows on mount
    void load();
  }, [load]);

  async function setArchived(row: FeedbackRow, archived: boolean) {
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/platform/feedback/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!response.ok) {
        toast.error(archived ? "Could not archive that." : "Could not restore that.");
        return;
      }
      toast.success(archived ? "Archived" : "Restored to the queue");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const rows = data?.rows ?? [];
  const areaCounts = new Map(
    (data?.areas.counts ?? []).map((row) => [row.area, row.count])
  );
  const lastPage = data ? Math.max(0, Math.ceil(data.total / data.pageSize) - 1) : 0;
  const liveCounts = data?.areas.counts ?? [];
  const activeAreas = liveCounts.filter((row) => row.count > 0).length;
  /* Ties resolve by the order the repository returns, which is alphabetical. */
  const busiest = liveCounts
    .filter((row) => isFeedbackArea(row.area) && row.count > 0)
    .reduce<{ area: FeedbackArea; count: number } | null>(
      (best, row) =>
        best && best.count >= row.count
          ? best
          : { area: row.area as FeedbackArea, count: row.count },
      null
    );

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Feedback</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What customers are telling us, across every organisation
        </p>
      </div>

      {error && <AlertBanner className="mb-4" variant="error" message={error} />}

      {/* ── Stat tiles ── */}
      {data && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatTile
            label="This view"
            value={data.total}
            detail={
              area
                ? FEEDBACK_AREA_LABEL[area]
                : showArchived
                  ? "including archived"
                  : "not yet archived"
            }
            accentColour={STAT_ACCENT.indigo}
          />
          <StatTile
            label="Last 90 days"
            value={data.areas.total}
            detail="messages received"
            accentColour={STAT_ACCENT.green}
          />
          <StatTile
            label="Busiest area"
            value={busiest ? busiest.count : 0}
            detail={busiest ? FEEDBACK_AREA_LABEL[busiest.area] : "nothing yet"}
            accentColour={STAT_ACCENT.amber}
          />
          <StatTile
            label="Areas active"
            value={activeAreas}
            detail={`of ${FEEDBACK_AREAS.length}`}
            accentColour={STAT_ACCENT.blue}
          />
        </div>
      )}

      {/*
        Chips scroll sideways on a phone rather than wrapping into four rows
        that push the list below the fold.
      */}
      {/* ── Filters ── */}
      <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-2 pb-1 sm:w-auto sm:flex-wrap">
          <AreaChip
            label="All areas"
            count={data?.areas.total}
            active={area === ""}
            onClick={() => {
              setArea("");
              setPage(0);
            }}
          />
          {/*
            Every area, always — not only the ones with a live message in the
            window. The counts come from a 90-day, unarchived query, so a chip
            built from them disappears exactly when its messages are archived
            or age out: tick "Show archived", and the rows appear in the list
            with no chip left to narrow to them.
          */}
          {FEEDBACK_AREAS.map((candidate) => (
            <AreaChip
              key={candidate}
              label={FEEDBACK_AREA_LABEL[candidate]}
              count={areaCounts.get(candidate) ?? 0}
              active={area === candidate}
              onClick={() => {
                setArea(candidate);
                setPage(0);
              }}
            />
          ))}

          <span className="mx-1 hidden w-px self-stretch bg-border sm:block" />
          <AreaChip
            label="Show archived"
            active={showArchived}
            onClick={() => {
              setShowArchived(!showArchived);
              setPage(0);
            }}
          />
        </div>
      </div>

      {loading ? (
        <PageLoading label="Loading feedback…" />
      ) : rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={Inbox}
          title={area ? "Nothing in this area yet" : "No feedback yet"}
          description={
            area
              ? "Try another area, or clear the filter."
              : "When members send feedback from inside the app, it lands here."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                  {isFeedbackArea(row.area)
                    ? FEEDBACK_AREA_LABEL[row.area]
                    : row.area}
                </span>
                <span className="font-medium text-foreground">
                  {row.membership.user.name ?? row.membership.user.email}
                </span>
                <span aria-hidden="true">·</span>
                <span>{row.organization.name}</span>
                <span aria-hidden="true">·</span>
                {/* No locale argument: the date is spelled the reader's way. */}
                <span>{new Date(row.createdAt).toLocaleDateString()}</span>
                {row.archivedAt && (
                  <span className="rounded-full bg-muted px-2 py-0.5">Archived</span>
                )}
              </div>

              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {row.message}
              </p>

              <div className="mt-4 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === row.id}
                  onClick={() => setArchived(row, !row.archivedAt)}
                >
                  {row.archivedAt ? (
                    <>
                      <ArchiveRestore className="mr-2 h-4 w-4" />
                      Restore
                    </>
                  ) : (
                    <>
                      <Archive className="mr-2 h-4 w-4" />
                      Archive
                    </>
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && data.total > data.pageSize && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <p className="text-xs text-muted-foreground">
            <MessagesSquare className="mr-1 inline h-3.5 w-3.5" />
            {data.total} in total
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function AreaChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors ${
        active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-border bg-card hover:bg-accent"
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}
