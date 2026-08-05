/**
 * My Tasks Page (Boundary Layer)
 *
 * A staff member's own assignments: accept or decline what's offered, clock in
 * and out of what they've taken, and ask to withdraw from something they can no
 * longer work.
 *
 * ## On the visual language
 *
 * This page predates the Phase 12 overhaul. It used shadcn `Card` primitives
 * where every other page uses the house panel, a bare `h2` with no subtitle, no
 * stat tiles, no icons, and a `<select>` with no background colour — which made
 * it unreadable in dark mode. It now matches Departments, Members and Calendar.
 *
 * ## Why it is built mobile-first
 *
 * This is the one page in the application read mostly on a phone, standing up,
 * often in a hurry — a staff member checking whether they're on tonight, or
 * clocking in at the door. So the action buttons are full-width and stacked
 * below `sm`, the sections that need a decision come first, and finished work
 * is collapsed behind a count rather than filling the screen.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  Inbox,
  LogIn,
  LogOut,
  Undo2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  DECLINE_REASONS,
  REASON_LABEL,
  reasonLabel,
} from "@/lib/decline-reasons";
import { Panel } from "@/components/ui/panel";
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  BUTTON_STRETCH_MOBILE,
} from "@/components/ui/button-styles";
import { cn } from "@/lib/utils";
import { ShiftRating } from "@/components/tasks/shift-rating";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Assignment {
  id: string;
  status: string;
  clockInTime: string | null;
  clockOutTime: string | null;
  rejectionReason: string | null;
  rejectionNotes: string | null;
  withdrawalReason: string | null;
  withdrawalNotes: string | null;
  satisfactionRating: number | null;
  satisfactionComment: string | null;
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** How many finished items to show before the "show all" toggle. */
const HISTORY_PREVIEW = 3;

/**
 * "Fri 3 Oct, 17:00 — 21:00", or just the start when there is no end.
 *
 * The end time was never shown before, which is the single most useful thing on
 * the card: "you're on at 5" and "you're on 5 til 9" are different messages, and
 * only one of them tells you whether you can make other plans.
 */
function shiftWhen(start: string | null, end: string | null): string | null {
  if (!start) return null;

  const from = new Date(start);
  const day = from.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const fromTime = from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!end) return `${day}, ${fromTime}`;

  const to = new Date(end);
  const toTime = to.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // A shift crossing midnight needs the second date, or "23:00 — 07:00" reads
  // as a sixteen-hour day in the wrong direction.
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay
    ? `${day}, ${fromTime} — ${toTime}`
    : `${day}, ${fromTime} — ${to.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${toTime}`;
}

/**
 * Clock times with their date.
 *
 * Previously `toLocaleTimeString()` alone, so a shift worked last Tuesday showed
 * as "09:00 — 17:00" with nothing saying which day — unreadable as soon as there
 * was more than one entry in the list.
 */
function clockedWhen(inAt: string | null, outAt: string | null): string | null {
  if (!inAt) return null;
  const from = new Date(inAt);
  const stamp = `${from.toLocaleDateString([], { day: "numeric", month: "short" })}, ${from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (!outAt) return `Clocked in ${stamp}`;

  const to = new Date(outAt);
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  return `${stamp} — ${to.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${hours.toFixed(1)}h`;
}

/**
 * When a finished assignment last mattered, for ordering history.
 *
 * Clock-out is the truest answer for work actually done; a declined shift never
 * had one, so it falls back to when it was scheduled. Anything with no date at
 * all sorts last rather than jumping to the top, which is what `0` would do
 * under a descending sort.
 */
function historyTime(a: Assignment): number {
  const stamp =
    a.clockOutTime ?? a.clockInTime ?? a.task.scheduledEnd ?? a.task.scheduledStart;
  return stamp ? new Date(stamp).getTime() : Number.NEGATIVE_INFINITY;
}




/** Title, status and scheduled window — the top of every assignment row. */
function AssignmentHeader({ a }: { a: Assignment }) {
  const when = shiftWhen(a.task.scheduledStart, a.task.scheduledEnd);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[14px] font-semibold">{a.task.title}</h4>
        <StatusBadge value={a.status} palette="assignmentStatus" />
      </div>
      {when && (
        <p className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {when}
        </p>
      )}
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        {a.task.department?.name || "No department"} · Assigned by{" "}
        {a.assignedBy.name || "Unknown"}
      </p>
    </div>
  );
}

/** The shared reason dropdown, used by both declining and withdrawing. */
function ReasonSelect({ name }: { name: string }) {
  return (
    <select
      name={name}
      required
      defaultValue=""
      aria-label="Reason"
      // bg-background and text-foreground are the point: without them this
      // rendered as light-on-light in dark mode and the options were unreadable.
      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
    >
      <option value="" disabled>
        Select a reason…
      </option>
      {DECLINE_REASONS.map((reason) => (
        <option key={reason} value={reason}>
          {REASON_LABEL[reason]}
        </option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

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
  const [showAllHistory, setShowAllHistory] = useState(false);

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
        return;
      }

      setAssignments(data);
    } catch {
      setError("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Runs one assignment action, guarding against a double submission.
   *
   * The second click of a double click used to land while the first was still
   * in flight; the server answered the second with "Assignment is not pending"
   * and the staff member saw an error for something that actually worked. The
   * in-flight id is checked here as well as on the button because a fast double
   * click lands before React repaints `disabled`.
   */
  /**
   * `successMessage` may be a function of the updated assignment.
   *
   * Declining is the reason: for a casual member it takes effect immediately,
   * and for a full-time member it becomes a request their manager has to
   * approve. Which one happened is the server's decision, and reading it off
   * the response is the only way the message cannot drift from the rule — a
   * copy of the policy in the client would eventually disagree with the copy
   * in the service, and the member would be told the wrong thing.
   */
  async function runAction(
    assignmentId: string,
    request: () => Promise<Response>,
    successMessage: string | ((updated: { status?: string }) => string),
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
      const updated = await res.json().catch(() => ({}));
      onSuccess?.();
      setSuccess(
        typeof successMessage === "function"
          ? successMessage(updated)
          : successMessage
      );
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
      (updated) =>
        updated.status === "decline_requested"
          ? "Sent to your manager — you are still rostered until they approve it"
          : "Task declined",
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

  async function onRequestWithdrawal(
    assignmentId: string,
    reason: string,
    notes?: string
  ) {
    await runAction(
      assignmentId,
      () =>
        fetch(`/api/assignments/${assignmentId}/withdraw?orgId=${orgId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason, notes }),
        }),
      "Withdrawal requested — your manager has been notified",
      () => setWithdrawingId(null)
    );
  }

  if (loading) return <PageLoading />;

  const pending = assignments.filter(
    // decline_requested belongs here, not in history: the member is still
    // rostered on the shift and the outcome is not decided. Filtering on
    // "pending" alone dropped the row from every group on the page, so a
    // full-time member who declined saw the shift simply disappear.
    (a) => a.status === "pending" || a.status === "decline_requested"
  );
  const active = assignments.filter(
    (a) => a.status === "accepted" || a.status === "withdrawal_requested"
  );
  const awaitingCompletion = assignments.filter((a) => a.status === "clocked_out");
  const completed = assignments.filter((a) => a.status === "completed");
  const rejected = assignments.filter((a) => a.status === "rejected");

  const onShift = active.filter((a) => a.clockInTime && !a.clockOutTime).length;

  /**
   * Finished work is previewed, not dumped — see HISTORY_PREVIEW.
   *
   * Sorted most-recent-first ACROSS both kinds. Concatenating completed then
   * rejected put every completed shift ahead of every declined one, so anyone
   * with more than a few completed shifts would never see a declined one in the
   * preview no matter how recent it was — and "show all" would be the only way
   * to find something that happened yesterday.
   */
  const history = [...completed, ...rejected].sort(
    (a, b) => historyTime(b) - historyTime(a)
  );
  const shownHistory = showAllHistory ? history : history.slice(0, HISTORY_PREVIEW);

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">My Tasks</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Your shifts — respond to what you&apos;ve been offered, and clock in
          when you start
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="To respond"
          value={pending.length}
          detail="awaiting your answer"
          accentColour={STAT_ACCENT.amber}
          valueColour={pending.length > 0 ? "text-amber-600 dark:text-amber-400" : ""}
        />
        <StatTile
          label="Upcoming"
          value={active.length}
          detail="shifts accepted"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="On shift"
          value={onShift}
          detail={onShift > 0 ? "clocked in now" : "not clocked in"}
          accentColour={STAT_ACCENT.green}
          valueColour={onShift > 0 ? "text-green-600 dark:text-green-400" : ""}
        />
        <StatTile
          label="Completed"
          value={completed.length}
          detail="finished shifts"
          accentColour={STAT_ACCENT.blue}
        />
      </div>

      {/* A failed load leaves the list empty too — don't claim there are no tasks. */}
      {!error && assignments.length === 0 && (
        <EmptyState
          title="No tasks assigned to you yet"
          description="When a manager assigns you a shift it will appear here, and you'll get a notification."
          icon={Inbox}
        />
      )}

      <div className="space-y-4">
        {/* ── Needs a response ── */}
        {pending.length > 0 && (
          <Panel
            title="Waiting on you"
            count={pending.length}
            icon={Inbox}
            bodyClassName="divide-y divide-border"
          >
            {pending.map((a) => {
              const busy = busyIds.includes(a.id);
              return (
                <div key={a.id} className="p-4">
                  <AssignmentHeader a={a} />

                  {a.task.description && (
                    <p className="mt-2 text-[13px] text-muted-foreground">
                      {a.task.description}
                    </p>
                  )}

                  {/*
                    A decline already with a manager offers no buttons. Accept
                    would contradict the request the member just made, and
                    Decline would let them file it twice.
                  */}
                  {a.status === "decline_requested" ? (
                    <p className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-[13px] text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300">
                      Waiting for your manager to approve. You are still rostered
                      on this shift until they do.
                    </p>
                  ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      onClick={() => onAccept(a.id)}
                      className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                    >
                      <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      {busy ? "Working…" : "Accept"}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setRejectingId(rejectingId === a.id ? null : a.id)}
                      className={cn(SECONDARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                    >
                      <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
                      Decline
                    </button>
                  </div>
                  )}

                  {rejectingId === a.id && a.status === "pending" && (
                    <form
                      className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = new FormData(e.currentTarget);
                        onReject(
                          a.id,
                          form.get("rejectionReason") as string,
                          (form.get("rejectionNotes") as string) || undefined
                        );
                      }}
                    >
                      <ReasonSelect name="rejectionReason" />
                      <Input
                        name="rejectionNotes"
                        placeholder="Anything else your manager should know (optional)"
                        className="h-9 text-sm"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy} className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}>
                          {busy ? "Declining…" : "Confirm decline"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejectingId(null)}
                          className={cn(SECONDARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {/* ── Accepted / in progress ── */}
        {active.length > 0 && (
          <Panel
            title="Your shifts"
            count={active.length}
            icon={CalendarClock}
            bodyClassName="divide-y divide-border"
          >
            {active.map((a) => {
              const busy = busyIds.includes(a.id);
              const clocked = clockedWhen(a.clockInTime, a.clockOutTime);

              return (
                <div key={a.id} className="p-4">
                  <AssignmentHeader a={a} />

                  {clocked && (
                    <p className="mt-1 flex items-center gap-1.5 text-[12px] text-green-600 dark:text-green-400">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {clocked}
                    </p>
                  )}

                  {a.status === "withdrawal_requested" ? (
                    <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      Withdrawal requested — {reasonLabel(a.withdrawalReason)}
                      {a.withdrawalNotes ? `: ${a.withdrawalNotes}` : ""}. Awaiting
                      your manager&apos;s decision.
                    </p>
                  ) : (
                    <>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!a.clockInTime && (
                          <button
                            disabled={busy}
                            onClick={() => onClockIn(a.id)}
                            className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                          >
                            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                            {busy ? "Working…" : "Clock in"}
                          </button>
                        )}
                        {a.clockInTime && !a.clockOutTime && (
                          <button
                            disabled={busy}
                            onClick={() => onClockOut(a.id)}
                            className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                          >
                            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                            {busy ? "Working…" : "Clock out"}
                          </button>
                        )}
                        {!a.clockInTime && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              setWithdrawingId(withdrawingId === a.id ? null : a.id)
                            }
                            className={cn(SECONDARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                          >
                            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Can&apos;t make it
                          </button>
                        )}
                      </div>

                      {withdrawingId === a.id && (
                        <form
                          className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const form = new FormData(e.currentTarget);
                            onRequestWithdrawal(
                              a.id,
                              form.get("reason") as string,
                              (form.get("notes") as string) || undefined
                            );
                          }}
                        >
                          <p className="text-[12px] text-muted-foreground">
                            Your manager decides whether to release you from this
                            shift. You stay assigned until they do.
                          </p>
                          <ReasonSelect name="reason" />
                          <Input
                            name="notes"
                            placeholder="Anything else they should know (optional)"
                            className="h-9 text-sm"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="submit"
                              disabled={busy}
                              className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                            >
                              {busy ? "Submitting…" : "Request withdrawal"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setWithdrawingId(null)}
                              className={cn(SECONDARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {/* ── Clocked out, not yet marked done ── */}
        {awaitingCompletion.length > 0 && (
          <Panel
            title="Finish off"
            count={awaitingCompletion.length}
            icon={Hourglass}
            bodyClassName="divide-y divide-border"
          >
            {awaitingCompletion.map((a) => {
              const busy = busyIds.includes(a.id);
              const clocked = clockedWhen(a.clockInTime, a.clockOutTime);
              return (
                <div key={a.id} className="p-4">
                  <AssignmentHeader a={a} />
                  {clocked && (
                    <p className="mt-1 text-[12px] text-muted-foreground">{clocked}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      onClick={() => onComplete(a.id)}
                      className={cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)}
                    >
                      <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      {busy ? "Working…" : "Mark as complete"}
                    </button>
                  </div>
                  <ShiftRating
                    assignmentId={a.id}
                    orgId={orgId}
                    rating={a.satisfactionRating}
                    comment={a.satisfactionComment}
                    onSaved={fetchAssignments}
                  />
                </div>
              );
            })}
          </Panel>
        )}

        {/* ── History ── */}
        {history.length > 0 && (
          <Panel
            title="Finished"
            count={history.length}
            icon={CircleCheck}
            bodyClassName="divide-y divide-border"
          >
            {shownHistory.map((a) => {
              const clocked = clockedWhen(a.clockInTime, a.clockOutTime);
              return (
                <div key={a.id} className="p-4">
                  <AssignmentHeader a={a} />
                  {clocked && (
                    <p className="mt-1 text-[12px] text-muted-foreground">{clocked}</p>
                  )}
                  {a.status === "rejected" && (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      You declined — {reasonLabel(a.rejectionReason)}
                      {a.rejectionNotes && `: ${a.rejectionNotes}`}
                    </p>
                  )}
                  {/* Only worked shifts can be rated. A declined one was never
                      experienced, and the decline reason already records why. */}
                  {a.status === "completed" && (
                    <ShiftRating
                      assignmentId={a.id}
                      orgId={orgId}
                      rating={a.satisfactionRating}
                      comment={a.satisfactionComment}
                      onSaved={fetchAssignments}
                    />
                  )}
                </div>
              );
            })}

            {history.length > HISTORY_PREVIEW && (
              <div className="p-3">
                <button
                  onClick={() => setShowAllHistory(!showAllHistory)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground"
                >
                  {showAllHistory
                    ? "Show less"
                    : `Show all ${history.length} finished shifts`}
                </button>
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
