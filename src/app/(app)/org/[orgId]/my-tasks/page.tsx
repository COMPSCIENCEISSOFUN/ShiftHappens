/**
 * My Tasks Page (Boundary Layer)
 *
 * Staff view of immediate active task assignments.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
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
import { ClipboardList, MapPin } from "lucide-react";

interface Assignment {
  id: string;
  status: string;
  clockInTime: string | null;
  clockOutTime: string | null;
  withdrawalReason: string | null;
  task: {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    instructions: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    department: { name: string } | null;
  };
  assignedBy: { name: string | null };
}

export default function MyTasksPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAssignments = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/my-tasks`);
      const data = await res.json();
      setAssignments(Array.isArray(data) ? data : []);
    } catch {
      setError("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void fetchAssignments();
  }, [fetchAssignments]);

  async function postAssignmentAction(
    assignmentId: string,
    action: "clock-in" | "clock-out" | "complete",
    successText: string
  ) {
    setError(null);
    try {
      const res = await fetch(
        `/api/assignments/${assignmentId}/${action}?orgId=${orgId}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const result = await res.json();
        setError(result.error);
        return;
      }
      const updated = await res.json();
      setAssignments((current) => current.map((assignment) => assignment.id === assignmentId ? {
        ...assignment,
        status: updated.status,
        clockInTime: updated.clockInTime ?? assignment.clockInTime,
        clockOutTime: updated.clockOutTime ?? assignment.clockOutTime,
      } : assignment));
      setSuccess(successText);
      void fetchAssignments();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onRequestWithdrawal(assignmentId: string, reason: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/assignments/${assignmentId}/withdraw?orgId=${orgId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }
      );
      if (!res.ok) {
        const result = await res.json();
        setError(result.error);
        return;
      }
      setWithdrawingId(null);
      setSuccess("Withdrawal requested. Your manager has been notified.");
      fetchAssignments();
    } catch {
      setError("Something went wrong");
    }
  }

  if (loading) return <PageLoading />;

  const active = assignments.filter((a) =>
    ["assigned", "in_progress", "withdrawal_requested"].includes(a.status)
  );
  const awaitingCompletion = assignments.filter((a) => a.status === "clocked_out");
  const completed = assignments.filter((a) => a.status === "completed");
  const inactive = assignments.filter((a) =>
    ["withdrawn", "cancelled"].includes(a.status)
  );

  return (
    <div className="max-w-4xl">
      <h2 className="mb-6 text-2xl font-bold">My Tasks</h2>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {assignments.length === 0 && <EmptyState title="No tasks assigned to you yet" />}

      <AssignmentSection
        title="Active"
        assignments={active}
        orgId={orgId}
        withdrawingId={withdrawingId}
        setWithdrawingId={setWithdrawingId}
        onClockIn={(id) => postAssignmentAction(id, "clock-in", "Clocked in")}
        onClockOut={(id) =>
          postAssignmentAction(id, "clock-out", "Clocked out. Mark the task complete when done.")
        }
        onComplete={(id) => postAssignmentAction(id, "complete", "Task marked complete")}
        onRequestWithdrawal={onRequestWithdrawal}
      />

      <AssignmentSection
        title="Awaiting completion"
        assignments={awaitingCompletion}
        orgId={orgId}
        withdrawingId={withdrawingId}
        setWithdrawingId={setWithdrawingId}
        onClockIn={() => {}}
        onClockOut={() => {}}
        onComplete={(id) => postAssignmentAction(id, "complete", "Task marked complete")}
        onRequestWithdrawal={onRequestWithdrawal}
      />

      <AssignmentSection
        title="Completed"
        assignments={completed}
        orgId={orgId}
        withdrawingId={withdrawingId}
        setWithdrawingId={setWithdrawingId}
        onClockIn={() => {}}
        onClockOut={() => {}}
        onComplete={() => {}}
        onRequestWithdrawal={onRequestWithdrawal}
      />

      <AssignmentSection
        title="Inactive"
        assignments={inactive}
        orgId={orgId}
        withdrawingId={withdrawingId}
        setWithdrawingId={setWithdrawingId}
        onClockIn={() => {}}
        onClockOut={() => {}}
        onComplete={() => {}}
        onRequestWithdrawal={onRequestWithdrawal}
      />
    </div>
  );
}

function AssignmentSection({
  title,
  assignments,
  withdrawingId,
  setWithdrawingId,
  onClockIn,
  onClockOut,
  onComplete,
  onRequestWithdrawal,
}: {
  title: string;
  assignments: Assignment[];
  orgId: string;
  withdrawingId: string | null;
  setWithdrawingId: (id: string | null) => void;
  onClockIn: (id: string) => void;
  onClockOut: (id: string) => void;
  onComplete: (id: string) => void;
  onRequestWithdrawal: (id: string, reason: string) => void;
}) {
  if (assignments.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-3 text-lg font-semibold">
        {title} ({assignments.length})
      </h3>
      <div className="space-y-3">
        {assignments.map((assignment) => (
          <Card key={assignment.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {assignment.task.title}
                <StatusBadge
                  value={assignment.status}
                  palette="assignmentStatus"
                />
              </CardTitle>
              <CardDescription>
                {assignment.task.department?.name || "No department"}
                {" - "}Assigned by {assignment.assignedBy.name || "Unknown"}
                {assignment.task.scheduledStart && (
                  <> - {new Date(assignment.task.scheduledStart).toLocaleString()}</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {assignment.task.description && (
                <p className="mb-3 text-sm text-muted-foreground">
                  {assignment.task.description}
                </p>
              )}
              {assignment.task.location && (
                <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4 shrink-0" />
                  {assignment.task.location}
                </p>
              )}
              {assignment.task.instructions && (
                <div className="mb-3 flex items-start gap-1.5 text-sm text-muted-foreground">
                  <ClipboardList className="mt-0.5 h-4 w-4 shrink-0" />
                  <p><span className="font-medium text-foreground">Instructions:</span> {assignment.task.instructions}</p>
                </div>
              )}

              {assignment.status === "withdrawal_requested" ? (
                <p className="text-sm text-muted-foreground">
                  Withdrawal requested
                  {assignment.withdrawalReason
                    ? ` - "${assignment.withdrawalReason}"`
                    : ""}
                  . Awaiting manager decision.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {assignment.status === "assigned" && (
                    <Button size="sm" onClick={() => onClockIn(assignment.id)}>
                      Clock In
                    </Button>
                  )}
                  {assignment.status === "in_progress" && (
                    <Button size="sm" onClick={() => onClockOut(assignment.id)}>
                      Clock Out
                    </Button>
                  )}
                  {assignment.status === "clocked_out" && (
                    <Button size="sm" onClick={() => onComplete(assignment.id)}>
                      Mark as complete
                    </Button>
                  )}
                  {assignment.status === "assigned" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setWithdrawingId(
                          withdrawingId === assignment.id ? null : assignment.id
                        )
                      }
                    >
                      Request withdrawal
                    </Button>
                  )}
                </div>
              )}

              {withdrawingId === assignment.id && (
                <form
                  className="mt-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const formData = new FormData(event.currentTarget);
                    onRequestWithdrawal(
                      assignment.id,
                      formData.get("reason") as string
                    );
                  }}
                >
                  <Input
                    name="reason"
                    required
                    minLength={3}
                    placeholder="Reason for withdrawing"
                  />
                  <Button type="submit" size="sm" variant="outline">
                    Submit request
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
