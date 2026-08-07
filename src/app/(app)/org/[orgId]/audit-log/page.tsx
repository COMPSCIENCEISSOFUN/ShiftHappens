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
import { usePermissions } from "@/components/layout/permission-provider";

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
  "assignment.accepted": "Assignment accepted",
  "assignment.rejected": "Assignment rejected",
  "assignment.clocked_in": "Clocked in",
  "assignment.clocked_out": "Clocked out",
  "assignment.completed": "Task completed",
  "assignment.withdrawal_requested": "Withdrawal requested",
  "assignment.withdrawal_approved": "Withdrawal approved",
  "assignment.withdrawal_denied": "Withdrawal denied",
  /*
   * The decline lifecycle, added with the full-time approval flow and missed
   * here. This map is both the display lookup AND the filter dropdown's option
   * list, so their absence meant two things at once: the entries rendered as
   * raw `assignment.decline_approved`, and a manager could not filter for them
   * at all — the approvals were in the log and unreachable from the screen.
   */
  "assignment.decline_requested": "Decline requested",
  "assignment.decline_approved": "Decline approved",
  "assignment.decline_denied": "Decline denied",
  "assignment.rated": "Assignment rated",
  "assignment.clock_corrected": "Clock time corrected",
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
  // `denied` and `approved` are matched explicitly: substring tests on
  // "rejected"/"accepted" miss both, so every decline entry came out grey.
  if (
    action.includes("deleted") ||
    action.includes("rejected") ||
    action.includes("denied") ||
    action.includes("deactivated")
  )
    return "bg-red-100 text-red-700";
  if (
    action.includes("created") ||
    action.includes("accepted") ||
    action.includes("approved") ||
    action.includes("activated")
  )
    return "bg-green-100 text-green-700";
  if (action.includes("clocked"))
    return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-600";
}

export default function AuditLogPage() {
  const { can } = usePermissions();

  const params = useParams();
  const orgId = params.orgId as string;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterAction, setFilterAction] = useState("");
  const [filterEntity, setFilterEntity] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * A refusal the permission cannot express.
   *
   * `audit:view` is plan-gated to Enterprise, and a company admin holds every
   * permission in the catalogue regardless of plan — so on Pro, `can` says yes
   * and every fetch comes back 403 with an upgrade message. Derived from the
   * server's answer rather than by fetching the plan again, so the page and the
   * route cannot come to disagree about who may be here.
   */
  const [planRefusal, setPlanRefusal] = useState<string | null>(null);
  const limit = 20;

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
      if (res.status === 403) {
        const body = await res.json().catch(() => null);
        setPlanRefusal(
          typeof body?.error === "string"
            ? body.error
            : "The audit log is not available on your current plan."
        );
        return;
      }
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the log from the server on mount and whenever the filters change
    fetchLogs();
  }, [orgId, offset, filterAction, filterEntity]);


  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  /*
   * The sidebar no longer links here without `audit:view`, but the URL still
   * resolved — and this page had no check of its own, so it rendered its
   * full surface and every action returned 403.
   *
   * Not a security boundary. The routes enforce this independently; this
   * is so the product does not offer what it will refuse.
   */
  if (planRefusal) {
    return (
      <div className="w-full">
        <EmptyState
          title="The audit log is an Enterprise feature"
          description={planRefusal}
        />
      </div>
    );
  }

  if (!can("audit:view")) {
    return (
      <div className="w-full">
        <EmptyState title="The audit log is available to company admins" description="It records every change made in the organisation, so access is kept narrow." />
      </div>
    );
  }

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
  if (entry.action === "assignment.rejected" && d.reason)
    return `${String(d.reason).replace(/_/g, " ")}${d.notes ? ` — ${d.notes}` : ""}`;
  if (entry.action === "task.updated") {
    const keys = Object.keys(d);
    return `updated ${keys.join(", ")}`;
  }

  return "";
}