/**
 * Dashboard Charts Component (Boundary Layer)
 * 
 * Client component that fetches reporting data and renders
 * four chart panels: completion trend, staff utilization,
 * department workload, and hours summary.
 * 
 * Uses inline CSS charts (no external library) to keep
 * the bundle light and avoid SSR issues.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";

interface CompletionTrend {
  date: string;
  label: string;
  completed: number;
}

interface StaffUtilization {
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}

interface DepartmentWorkload {
  name: string;
  color: string;
  taskCount: number;
  completedCount: number;
}

interface HoursSummary {
  totalLogged: number;
  totalCapacity: number;
  percentage: number;
}

interface ReportingData {
  completionTrend: CompletionTrend[];
  staffUtilization: StaffUtilization[];
  departmentWorkload: DepartmentWorkload[];
  hoursSummary: HoursSummary;
}

export function DashboardCharts({ orgId }: { orgId: string }) {
  const [data, setData] = useState<ReportingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/reports`);
      if (!res.ok) {
        setError("Failed to load reports");
        return;
      }
      const result = await res.json();
      setData(result);
      setError(null);
    } catch {
      setError("Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void fetchReports();
  }, [fetchReports]);

  if (loading) {
    return (
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-4 w-32 rounded bg-muted animate-pulse" />
            </CardHeader>
            <CardContent>
              <div className="h-32 rounded bg-muted animate-pulse" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return <AlertBanner message={error} variant="error" className="mb-8" />;
  }

  if (!data) return null;

  const maxCompleted = Math.max(...data.completionTrend.map((d) => d.completed), 1);

  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2">
      {/* Task completion trend */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Task completions (7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.completionTrend.every((d) => d.completed === 0) ? (
            <EmptyState title="No completed tasks in the last 7 days" />
          ) : (
            <div className="flex items-end gap-2" style={{ height: "120px" }}>
              {data.completionTrend.map((day) => (
                <div
                  key={day.date}
                  className="flex flex-1 flex-col items-center gap-1"
                >
                  <span className="text-xs text-muted-foreground">
                    {day.completed > 0 ? day.completed : ""}
                  </span>
                  <div
                    className="w-full rounded-t bg-blue-400"
                    style={{
                      height: `${(day.completed / maxCompleted) * 90}px`,
                      minHeight: day.completed > 0 ? "4px" : "0px",
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {day.label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Staff utilization */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staff utilization (7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.staffUtilization.length === 0 ? (
            <EmptyState title="No staff members found" />
          ) : data.staffUtilization.every((s) => s.hoursWorked === 0) ? (
            <EmptyState title="No hours logged in the last 7 days" />
          ) : (
            <div className="space-y-3">
              {data.staffUtilization.slice(0, 5).map((staff) => (
                <div key={staff.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground truncate mr-2">
                      {staff.name}
                    </span>
                    <span
                      className={`font-medium ${
                        staff.percentage >= 90
                          ? "text-amber-600"
                          : "text-foreground"
                      }`}
                    >
                      {staff.percentage}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        staff.percentage >= 90
                          ? "bg-amber-400"
                          : staff.percentage >= 50
                          ? "bg-blue-400"
                          : "bg-blue-300"
                      }`}
                      style={{ width: `${Math.min(staff.percentage, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Department workload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Department workload</CardTitle>
        </CardHeader>
        <CardContent>
          {data.departmentWorkload.length === 0 ? (
            <EmptyState title="No departments found" />
          ) : (
            <div className="space-y-3">
              {data.departmentWorkload.map((dept) => (
                <div key={dept.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: dept.color }}
                      />
                      {dept.name}
                    </span>
                    <span className="font-medium">
                      {dept.taskCount} task{dept.taskCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${
                          data.departmentWorkload[0].taskCount > 0
                            ? (dept.taskCount /
                                data.departmentWorkload[0].taskCount) *
                              100
                            : 0
                        }%`,
                        backgroundColor: dept.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Hours logged */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hours logged (this week)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <div className="relative" style={{ width: "120px", height: "120px" }}>
              <svg viewBox="0 0 36 36" style={{ width: "120px", height: "120px", transform: "rotate(-90deg)" }}>
                <circle
                  cx="18"
                  cy="18"
                  r="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-muted"
                />
                <circle
                  cx="18"
                  cy="18"
                  r="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeDasharray={`${(data.hoursSummary.percentage / 100) * 88} 88`}
                  strokeLinecap="round"
                  className="text-blue-400"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-medium">
                  {data.hoursSummary.totalLogged}h
                </span>
                <span className="text-xs text-muted-foreground">
                  of {data.hoursSummary.totalCapacity}h
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
