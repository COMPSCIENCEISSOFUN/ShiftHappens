/**
 * My Tasks Page (Boundary Layer)
 * 
 * Staff view of their own task assignments.
 * Can accept/reject pending assignments and clock in/out.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";

interface Assignment {
  id: string;
  status: string;
  clockInTime: string | null;
  clockOutTime: string | null;
  rejectionReason: string | null;
  rejectionNotes: string | null;
  withdrawalReason: string | null;
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    department: { name: string } | null;
    createdBy: { name: string | null };
  };
  assignedBy: { name: string | null };
}

export default function MyTasksPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  useEffect(() => {
    fetchAssignments();
  }, [orgId]);

  async function fetchAssignments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/my-tasks`);
      const data = await res.json();

      // A 403 or 500 body is `{ error }`, not an array. Without this the page
      // threw on `.filter` below and rendered nothing but a blank screen.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load tasks"
        );
        setAssignments([]);
        return;
      }

      setAssignments(data);
      setError(null);
    } catch {
      setError("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Every action on this page is a state transition the API only allows once.
   * A double click used to fire two requests, so the second came back with
   * "Assignment is not pending" and the staff member saw an error for something
   * that actually worked. The in-flight id is checked here as well as on the
   * button because a fast double click lands before React repaints `disabled`.
   */
  async function runAction(
    assignmentId: string,
    request: () => Promise<Response>,
    successMessage: string,
    onSuccess?: () => void
  ) {
    if (busyIds.includes(assignmentId)) return;

    setBusyIds((prev) => [...prev, assignmentId]);
    setError(null);

    try {
      const res = await request();
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setError(result.error || "Something went wrong");
        return;
      }
      onSuccess?.();
      setSuccess(successMessage);
      await fetchAssignments();
    } catch {
      setError("Something went wrong");
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== assignmentId));
    }
  }

  async function onAccept(assignmentId: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/accept?orgId=${orgId}`, {
          method: "POST",
        }),
      "Task accepted"
    );
  }

  async function onReject(assignmentId: string, reason: string, notes?: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/reject?orgId=${orgId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rejectionReason: reason, rejectionNotes: notes }),
        }),
      "Task rejected",
      () => setRejectingId(null)
    );
  }

  async function onClockIn(assignmentId: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/clock-in?orgId=${orgId}`, {
          method: "POST",
        }),
      "Clocked in"
    );
  }

  async function onClockOut(assignmentId: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/clock-out?orgId=${orgId}`, {
          method: "POST",
        }),
      "Clocked out — mark the task complete when you're done"
    );
  }

  async function onComplete(assignmentId: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/complete?orgId=${orgId}`, {
          method: "POST",
        }),
      "Task marked as completed"
    );
  }

  async function onRequestWithdrawal(assignmentId: string, reason: string) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/withdraw?orgId=${orgId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
      "Withdrawal requested — your manager has been notified",
      () => setWithdrawingId(null)
    );
  }

  if (loading) return <PageLoading />;

  const pending = assignments.filter((a) => a.status === "pending");
  const active = assignments.filter(
    (a) => a.status === "accepted" || a.status === "withdrawal_requested"
  );
  const awaitingCompletion = assignments.filter((a) => a.status === "clocked_out");
  const completed = assignments.filter((a) => a.status === "completed");
  const rejected = assignments.filter((a) => a.status === "rejected");

  return (
    <div className="max-w-4xl">
      <h2 className="mb-6 text-2xl font-bold">My Tasks</h2>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* A failed load leaves the list empty too — don't claim there are no tasks. */}
      {!error && assignments.length === 0 && (
        <EmptyState title="No tasks assigned to you yet" />
      )}

      {/* Pending assignments */}
      {pending.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-lg font-semibold">
            Pending ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map((a) => {
              const busy = busyIds.includes(a.id);

              return (
                <Card key={a.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {a.task.title}
                      <StatusBadge value={a.status} palette="assignmentStatus" />
                    </CardTitle>
                    <CardDescription>
                      {a.task.department?.name || "No department"}
                      {" · "}Assigned by {a.assignedBy.name || "Unknown"}
                      {a.task.scheduledStart && (
                        <> · {new Date(a.task.scheduledStart).toLocaleString()}</>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {a.task.description && (
                      <p className="mb-3 text-sm text-muted-foreground">{a.task.description}</p>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => onAccept(a.id)}>
                        {busy ? "Working…" : "Accept"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setRejectingId(rejectingId === a.id ? null : a.id)}
                      >
                        Reject
                      </Button>
                    </div>
                    {rejectingId === a.id && (
                      <form
                        className="mt-3 space-y-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const formData = new FormData(e.currentTarget);
                          onReject(
                            a.id,
                            formData.get("rejectionReason") as string,
                            (formData.get("rejectionNotes") as string) || undefined
                          );
                        }}
                      >
                        <div className="space-y-1">
                          <select
                            name="rejectionReason"
                            required
                            className="w-full rounded-md border px-3 py-2 text-sm"
                          >
                            <option value="">Select a reason...</option>
                            <option value="schedule_conflict">Schedule conflict</option>
                            <option value="feeling_unwell">Feeling unwell</option>
                            <option value="exceeds_preferred_hours">Exceeds preferred hours</option>
                            <option value="transport_issues">Transport issues</option>
                            <option value="insufficient_notice">Insufficient notice</option>
                            <option value="rest_period_needed">Rest period needed</option>
                            <option value="personal_reasons">Personal reasons</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <Input
                          name="rejectionNotes"
                          placeholder="Additional notes (optional)"
                        />
                        <Button type="submit" size="sm" variant="outline" disabled={busy}>
                          {busy ? "Rejecting…" : "Confirm rejection"}
                        </Button>
                      </form>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Active assignments */}
      {active.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-lg font-semibold">
            Active ({active.length})
          </h3>
          <div className="space-y-3">
            {active.map((a) => {
              const busy = busyIds.includes(a.id);

              return (
                <Card key={a.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {a.task.title}
                      <StatusBadge value={a.status} palette="assignmentStatus" />
                    </CardTitle>
                    <CardDescription>
                      {a.task.department?.name || "No department"}
                      {a.clockInTime && (
                        <> · Clocked in: {new Date(a.clockInTime).toLocaleTimeString()}</>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {a.status === "withdrawal_requested" ? (
                      <p className="text-sm text-muted-foreground">
                        Withdrawal requested
                        {a.withdrawalReason ? ` — "${a.withdrawalReason}"` : ""}.
                        {" "}Awaiting your manager&apos;s decision.
                      </p>
                    ) : (
                      <>
                        <div className="flex gap-2">
                          {!a.clockInTime && (
                            <Button size="sm" disabled={busy} onClick={() => onClockIn(a.id)}>
                              {busy ? "Working…" : "Clock In"}
                            </Button>
                          )}
                          {a.clockInTime && !a.clockOutTime && (
                            <Button size="sm" disabled={busy} onClick={() => onClockOut(a.id)}>
                              {busy ? "Working…" : "Clock Out"}
                            </Button>
                          )}
                          {!a.clockInTime && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                setWithdrawingId(withdrawingId === a.id ? null : a.id)
                              }
                            >
                              Request withdrawal
                            </Button>
                          )}
                        </div>
                        {withdrawingId === a.id && (
                          <form
                            className="mt-3 space-y-3"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const formData = new FormData(e.currentTarget);
                              onRequestWithdrawal(
                                a.id,
                                formData.get("reason") as string
                              );
                            }}
                          >
                            <Input
                              name="reason"
                              required
                              minLength={3}
                              placeholder="Reason for withdrawing (e.g. schedule conflict)"
                            />
                            <Button type="submit" size="sm" variant="outline" disabled={busy}>
                              {busy ? "Submitting…" : "Submit request"}
                            </Button>
                          </form>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Awaiting completion (clocked out, not yet marked done) */}
      {awaitingCompletion.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-lg font-semibold">
            Awaiting completion ({awaitingCompletion.length})
          </h3>
          <div className="space-y-3">
            {awaitingCompletion.map((a) => (
              <Card key={a.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {a.task.title}
                    <StatusBadge value={a.status} palette="assignmentStatus" />
                  </CardTitle>
                  <CardDescription>
                    {a.clockInTime && new Date(a.clockInTime).toLocaleTimeString()}
                    {a.clockOutTime && ` — ${new Date(a.clockOutTime).toLocaleTimeString()}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="sm"
                    disabled={busyIds.includes(a.id)}
                    onClick={() => onComplete(a.id)}
                  >
                    {busyIds.includes(a.id) ? "Working…" : "Mark as complete"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-lg font-semibold">
            Completed ({completed.length})
          </h3>
          <div className="space-y-3">
            {completed.map((a) => (
              <Card key={a.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {a.task.title}
                    <StatusBadge value={a.status} palette="assignmentStatus" />
                  </CardTitle>
                  <CardDescription>
                    {a.clockInTime && new Date(a.clockInTime).toLocaleTimeString()}
                    {a.clockOutTime && ` — ${new Date(a.clockOutTime).toLocaleTimeString()}`}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <div>
          <h3 className="mb-3 text-lg font-semibold">
            Rejected ({rejected.length})
          </h3>
          <div className="space-y-3">
            {rejected.map((a) => (
              <Card key={a.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {a.task.title}
                    <StatusBadge value={a.status} palette="assignmentStatus" />
                  </CardTitle>
                  <CardDescription>
                    Reason: {a.rejectionReason?.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                    {a.rejectionNotes && ` — ${a.rejectionNotes}`}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}