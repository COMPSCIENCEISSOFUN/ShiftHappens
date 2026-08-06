/**
 * Leave Requests Page (Boundary Layer)
 *
 * Everything awaiting this reviewer's decision, in one list.
 *
 * ## Why a page as well as the dashboard card
 *
 * They fail differently. A dashboard card is seen when somebody logs in and
 * scrolled past when they do not; a nav item with a count stays until the work
 * is done. And a manager sitting down to answer four requests wants a list, not
 * four cards among unrelated alerts.
 *
 * Thin on purpose — the panel is shared with both dashboards, so the decision
 * logic exists once.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarOff, Lock } from "lucide-react";
import {
  LeaveRequestsPanel,
  type PendingLeave,
} from "@/components/dashboard/leave-requests-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { usePermissions } from "@/components/layout/permission-provider";

export default function LeaveRequestsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const { can } = usePermissions();
  const mayReview = can("members:request_availability");

  const [requests, setRequests] = useState<PendingLeave[]>([]);
  /*
   * Starts false for somebody who cannot review, rather than being switched off
   * inside the effect. Setting it there is a synchronous setState in an effect
   * — a cascading render for a value that was knowable before the first one.
   */
  const [loading, setLoading] = useState(mayReview);
  const [error, setError] = useState<string | null>(null);

  async function fetchRequests() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/leave`);
      const body = await res.json();
      if (!res.ok || !Array.isArray(body)) {
        setError(
          typeof body?.error === "string" ? body.error : "Failed to load requests"
        );
        return;
      }
      setRequests(body);
      setError(null);
    } catch {
      setError("Failed to load requests");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!mayReview) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the pending requests from the server on mount
    fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mayReview, orgId]);

  async function decide(id: string, decision: "approved" | "rejected") {
    const res = await fetch(`/api/organizations/${orgId}/leave/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to record the decision");
      return;
    }
    // Refetched rather than spliced: a second reviewer may have answered
    // something else in the list while this one was deciding.
    setError(null);
    await fetchRequests();
  }

  /*
   * The page answers rather than 404s for somebody without the permission. The
   * nav item is hidden from them, so arriving here means a typed URL or a
   * shared link — and the honest answer to that is "not yours", not a lie about
   * the page existing. The API refuses them regardless.
   */
  if (!mayReview) {
    return (
      <div className="w-full">
        <EmptyState
          icon={Lock}
          title="Not available to you"
          description="Only people who can review availability see leave requests."
        />
      </div>
    );
  }

  if (loading) return <PageLoading />;

  return (
    <div className="w-full">
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          Leave requests
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Full-time staff stay on the roster until you approve. Nothing here
          changes anyone&apos;s schedule on its own.
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {requests.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title="Nothing to review"
          description="Leave requested by full-time staff will appear here."
        />
      ) : (
        <LeaveRequestsPanel requests={requests} onDecide={decide} />
      )}
    </div>
  );
}
