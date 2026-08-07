"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CalendarDays, Clock3, MapPin } from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";

type Assignment = {
  id: string;
  status: string;
  task: {
    id: string;
    title: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    location: string | null;
    department: { name: string } | null;
  };
};

type ScheduleDay = { key: string; label: string; assignments: Assignment[] };

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default function MyCalendarPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`/api/organizations/${orgId}/my-tasks`);
        const data = await response.json();
        if (!response.ok || !Array.isArray(data)) throw new Error(data?.error || "Failed to load your schedule");
        setAssignments(data);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Failed to load your schedule");
      } finally {
        setLoading(false);
      }
    })();
  }, [orgId]);

  const schedule = useMemo<ScheduleDay[]>(() => {
    const byDay = new Map<string, ScheduleDay>();
    assignments
      .filter((assignment) => assignment.task.scheduledStart)
      .sort((a, b) => new Date(a.task.scheduledStart!).getTime() - new Date(b.task.scheduledStart!).getTime())
      .forEach((assignment) => {
        const date = new Date(assignment.task.scheduledStart!);
        const key = date.toDateString();
        const existing = byDay.get(key);
        if (existing) {
          existing.assignments.push(assignment);
          return;
        }
        byDay.set(key, {
          key,
          label: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date),
          assignments: [assignment],
        });
      });
    return [...byDay.values()];
  }, [assignments]);

  if (loading) return <PageLoading label="Loading your schedule" />;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Personal schedule</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">My Calendar</h1>
          <p className="mt-1 text-sm text-muted-foreground">See your upcoming work at a glance, then open My Tasks when it is time to act.</p>
        </div>
        <Link href={`/org/${orgId}/my-tasks`} className="inline-flex h-8 w-fit items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted">My Tasks</Link>
      </div>

      {error && <AlertBanner className="mb-4" variant="error" message={error} />}
      {!error && schedule.length === 0 && <EmptyState title="No scheduled work yet" description="When a manager schedules work for you, it will appear here." />}

      <div className="space-y-6">
        {schedule.map((day) => (
          <section key={day.key} aria-label={day.label}>
            <div className="mb-3 flex items-center gap-2"><CalendarDays className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">{day.label}</h2><span className="text-xs text-muted-foreground">{day.assignments.length} {day.assignments.length === 1 ? "shift" : "shifts"}</span></div>
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              {day.assignments.map((assignment, index) => (
                <article key={assignment.id} className={`grid gap-3 p-4 sm:grid-cols-[132px_minmax(0,1fr)_auto] sm:items-center ${index > 0 ? "border-t border-border" : ""}`}>
                  <div className="flex items-center gap-2 text-sm font-medium sm:block"><Clock3 className="h-4 w-4 text-primary sm:mb-1" /><span>{formatTime(assignment.task.scheduledStart!)}{assignment.task.scheduledEnd ? ` - ${formatTime(assignment.task.scheduledEnd)}` : ""}</span></div>
                  <div className="min-w-0"><h3 className="truncate font-semibold">{assignment.task.title}</h3><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{assignment.task.department?.name || "No department"}</span>{assignment.task.location && <><span aria-hidden="true">|</span><span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{assignment.task.location}</span></>}</p></div>
                  <StatusBadge value={assignment.status} palette="assignmentStatus" />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
