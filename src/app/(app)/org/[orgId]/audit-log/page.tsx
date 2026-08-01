/**
 * Audit Log Page (Boundary Layer)
 * 
 * Displays a filterable, paginated list of all recorded
 * actions in the organization. Company Admin only.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string } | null;
}

const ACTION_LABELS: Record<string, string> = {
  "task.created": "Task created",
  "task.updated": "Task updated",
  "task.deleted": "Task deleted",
  "task.assigned": "Staff assigned",
  "task.unassigned": "Staff unassigned",
  "assignment.clocked_in": "Clocked in",
  "assignment.clocked_out": "Clocked out",
  "assignment.completed": "Task completed",
  "assignment.withdrawal_requested": "Withdrawal requested",
  "assignment.withdrawal_approved": "Withdrawal approved",
  "assignment.withdrawal_denied": "Withdrawal denied",
  "assignment.eligibility_overridden": "Eligibility overridden",
  "member.invited": "Member invited",
  "member.role_changed": "Role changed",
  "member.activated": "Member activated",
  "member.deactivated": "Member deactivated",
  "department.created": "Department created",
  "department.updated": "Department updated",
  "department.deleted": "Department deleted",
  "settings.updated": "Settings updated",
  "role.created": "Role created",
  "role.updated": "Role updated",
  "role.deleted": "Role deleted",
};

function actionColor(action: string): string {
  if (action.includes("deleted") || action.includes("rejected") || action.includes("deactivated"))
    return "bg-red-100 text-red-700";
  if (action.includes("created") || action.includes("accepted") || action.includes("activated"))
    return "bg-green-100 text-green-700";
  if (action.includes("clocked"))
    return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-600";
}

export default function AuditLogPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterAction, setFilterAction] = useState("");
  const [filterEntity, setFilterEntity] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  useEffect(() => {
    fetchLogs();
  }, [orgId, offset, filterAction, filterEntity]);

  async function fetchLogs() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      if (filterAction) params.set("action", filterAction);
      if (filterEntity) params.set("entityType", filterEntity);

      const res = await fetch(
        `/api/organizations/${orgId}/audit-logs?${params.toString()}`
      );
      if (!res.ok) {
        setError("Failed to load audit logs");
        return;
      }
      const data = await res.json();
      setEntries(data.logs);
      setTotal(data.total);
      setError(null);
    } catch {
      setError("Failed to load audit logs");
    } finally {
      setLoading(false);
    }
  }

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="max-w-5xl">
      <h2 className="mb-4 text-2xl font-bold">Audit Log</h2>

      {error && <AlertBanner message={error} variant="error" />}

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <select
          className="rounded-md border px-3 py-1.5 text-sm"
          value={filterAction}
          onChange={(e) => {
            setFilterAction(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          className="rounded-md border px-3 py-1.5 text-sm"
          value={filterEntity}
          onChange={(e) => {
            setFilterEntity(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All entities</option>
          <option value="task">Tasks</option>
          <option value="assignment">Assignments</option>
          <option value="department">Departments</option>
          <option value="member">Members</option>
          <option value="role">Roles</option>
          <option value="settings">Settings</option>
        </select>
        <span className="flex items-center text-sm text-muted-foreground">
          {total} entries
        </span>
      </div>

      {/* Log entries */}
      {loading ? (
        <PageLoading />
      ) : entries.length === 0 ? (
        <EmptyState title="No audit entries found" />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardContent className="flex items-center gap-4 py-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${actionColor(entry.action)}`}
                >
                  {ACTION_LABELS[entry.action] || entry.action}
                </span>
                <div className="flex-1 text-sm">
                  <span className="font-medium">
                    {entry.user?.name || entry.user?.email || "System"}
                  </span>
                  {entry.details && (
                    <span className="ml-2 text-muted-foreground">
                      {formatDetails(entry)}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function formatDetails(entry: AuditEntry): string {
  if (!entry.details) return "";
  const d = entry.details;

  if (entry.action === "task.created" && d.title) return `"${d.title}"`;
  if (entry.action === "task.assigned" && d.membershipIds)
    return `${(d.membershipIds as string[]).length} staff member(s)`;
  if (entry.action === "task.updated") {
    const keys = Object.keys(d);
    return `updated ${keys.join(", ")}`;
  }

  return "";
}
