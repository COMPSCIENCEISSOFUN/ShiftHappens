"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";

type Assignment = { id: string; status: string; task: { id: string; title: string; scheduledStart: string | null; scheduledEnd: string | null; location: string | null; department: { name: string } | null } };

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
      } finally { setLoading(false); }
    })();
  }, [orgId]);

  const scheduled = useMemo(() => assignments.filter((assignment) => assignment.task.scheduledStart).sort((a, b) => new Date(a.task.scheduledStart!).getTime() - new Date(b.task.scheduledStart!).getTime()), [assignments]);
  if (loading) return <PageLoading label="Loading your schedule" />;

  return <div className="max-w-3xl"><h2 className="text-2xl font-bold">My Calendar</h2><p className="mt-1 text-sm text-muted-foreground">Your assigned work, ordered by schedule.</p>{error && <AlertBanner className="mt-4" variant="error" message={error} />}{!error && scheduled.length === 0 && <div className="mt-6"><EmptyState title="No scheduled work yet" description="When you are assigned scheduled work, it will appear here." /></div>}<div className="mt-6 space-y-3">{scheduled.map((assignment) => <article key={assignment.id} className="border-l-4 border-indigo-500 bg-card px-4 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{assignment.task.title}</h3><p className="mt-1 text-sm text-muted-foreground">{new Date(assignment.task.scheduledStart!).toLocaleString()}{assignment.task.scheduledEnd ? ` - ${new Date(assignment.task.scheduledEnd).toLocaleString()}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{assignment.task.department?.name || "No department"}{assignment.task.location ? ` | ${assignment.task.location}` : ""}</p></div><StatusBadge value={assignment.status} palette="assignmentStatus" /></div></article>)}</div></div>;
}
