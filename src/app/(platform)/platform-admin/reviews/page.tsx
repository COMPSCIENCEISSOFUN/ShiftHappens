/**
 * Platform Admin — Review Moderation (Boundary Layer)
 *
 * Nothing a customer writes reaches the landing page without passing through
 * here, and an edit by its author sends it back — so a review sitting in
 * "Awaiting review" may be one nobody has seen yet, or one that was live
 * yesterday and has since been reworded.
 *
 * Approve and reject are the only two decisions offered. Returning a review to
 * pending is not something a moderator does; that is what editing it means.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquareQuote, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABEL,
  type ReviewStatus,
} from "@/lib/review-status";

interface QueueRow {
  id: string;
  rating: number;
  body: string;
  status: string;
  updatedAt: string;
  organization: { id: string; name: string };
  membership: { id: string; role: string; user: { id: string; name: string | null } };
}

interface QueueResponse {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { status: string; count: number }[];
}

export default function PlatformReviewsPage() {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ status });
      if (page > 0) query.set("page", String(page));
      const response = await fetch(`/api/platform/reviews?${query.toString()}`);
      if (!response.ok) {
        setError("Could not load reviews. Refresh to try again.");
        setData(null);
        return;
      }
      const body: QueueResponse = await response.json();
      setError(null);
      setData(body);
      if (body.page !== page) setPage(body.page);
    } catch {
      setError("Could not reach the server.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: QueueRow, next: "approved" | "rejected") {
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/platform/reviews/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!response.ok) {
        toast.error("Could not save that decision.");
        return;
      }
      toast.success(next === "approved" ? "Published" : "Not published");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const counts = new Map((data?.counts ?? []).map((row) => [row.status, row.count]));
  const rows = data?.rows ?? [];
  const lastPage = data ? Math.max(0, Math.ceil(data.total / data.pageSize) - 1) : 0;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Reviews</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Nothing appears on the landing page until you approve it, and editing
          one sends it back here
        </p>
      </div>

      {error && <AlertBanner className="mb-4" variant="error" message={error} />}

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Awaiting review"
          value={counts.get("pending") ?? 0}
          detail="needs a decision"
          accentColour={STAT_ACCENT.amber}
        />
        <StatTile
          label="Published"
          value={counts.get("approved") ?? 0}
          detail="live on the site"
          accentColour={STAT_ACCENT.green}
        />
        <StatTile
          label="Not published"
          value={counts.get("rejected") ?? 0}
          detail="declined"
          accentColour={STAT_ACCENT.slate}
        />
        <StatTile
          label="Written in total"
          value={[...counts.values()].reduce((sum, n) => sum + n, 0)}
          detail="one per member"
          accentColour={STAT_ACCENT.indigo}
        />
      </div>

      {/* ── Filters ── */}
      <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-2 pb-1 sm:w-auto sm:flex-wrap">
          {REVIEW_STATUSES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setStatus(candidate);
                setPage(0);
              }}
              aria-pressed={status === candidate}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                status === candidate
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border bg-card hover:bg-accent"
              }`}
            >
              {REVIEW_STATUS_LABEL[candidate]}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {counts.get(candidate) ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PageLoading label="Loading reviews…" />
      ) : rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={MessageSquareQuote}
          title={
            status === "pending"
              ? "Nothing waiting"
              : `Nothing marked ${REVIEW_STATUS_LABEL[status].toLowerCase()}`
          }
          description={
            status === "pending"
              ? "When a member writes or changes a review, it lands here."
              : "Try another filter."
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
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      className={`h-3.5 w-3.5 ${
                        i < row.rating
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/30"
                      }`}
                    />
                  ))}
                </span>
                <span className="font-medium text-foreground">
                  {row.membership.user.name ?? "A member"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{row.organization.name}</span>
                <span aria-hidden="true">·</span>
                {/* No locale argument: spelled the reader's way. */}
                <span>{new Date(row.updatedAt).toLocaleDateString()}</span>
              </div>

              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {row.body}
              </p>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === row.id || row.status === "rejected"}
                  onClick={() => decide(row, "rejected")}
                >
                  <ThumbsDown className="mr-2 h-4 w-4" />
                  Do not publish
                </Button>
                <Button
                  size="sm"
                  disabled={busyId === row.id || row.status === "approved"}
                  onClick={() => decide(row, "approved")}
                >
                  <ThumbsUp className="mr-2 h-4 w-4" />
                  Publish
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
          <p className="text-xs text-muted-foreground">{data.total} in total</p>
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
