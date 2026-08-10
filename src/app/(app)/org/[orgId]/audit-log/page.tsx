/**
 * Audit Log Page (Boundary Layer)
 * 
 * Displays a filterable, paginated list of all recorded
 * actions in the organization. Company Admin only.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { AUDIT_ENTITY_LABELS, AUDIT_ENTITY_TYPES } from "@/lib/audit-entities";
import type { AuditAction } from "@/lib/audit-actions";
import { Panel } from "@/components/ui/panel";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { PlanLocked } from "@/components/ui/plan-gate";

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string } | null;
}

/**
 * A readable name for every action.
 *
 * `Record<AuditAction, string>` rather than `Record<string, string>`, which is
 * the whole change: 23 of the 53 actions had no entry here and rendered as raw
 * strings — a manager saw `certification.verified` and
 * `membership.contracted_days_set`. Nothing objected, because a loose record
 * accepts any subset.
 *
 * Now adding an action without naming it fails the build. The filter below is
 * built from this map, so an unnamed action would also have been unfilterable.
 */
const ACTION_LABELS: Record<AuditAction, string> = {
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
  "task.recurring_generated": "Recurring shifts generated",
  "membership.seniority_overridden": "Seniority overridden",
  "membership.availability_review_requested": "Availability review requested",
  "membership.contracted_days_set": "Contracted days set",
  "member.joined": "Member joined",
  "department.archived": "Department archived",
  "department.unarchived": "Department restored",
  "leave.approved": "Leave approved",
  "leave.rejected": "Leave declined",
  "certification.submitted": "Certification submitted",
  "certification.verified": "Certification verified",
  "certification.rejected": "Certification rejected",
  "certification.revoked": "Certification revoked",
  "certification.withdrawn": "Certification withdrawn",
  "certification_type.added": "Certificate added to list",
  "certification_type.removed": "Certificate removed from list",
  "work_rule.created": "Work rule created",
  "work_rule.updated": "Work rule updated",
  "work_rule.deleted": "Work rule deleted",
  "user.password_changed": "Password changed",
  "user.profile_updated": "Profile updated",
  "organization.updated": "Organisation updated",
  "organization.suspended": "Organisation suspended",
  "organization.reactivated": "Organisation reactivated",
  "organization.tier_changed": "Plan changed",
  "subscription.checkout_started": "Checkout started",
  "subscription.upgraded": "Subscription upgraded",
  "subscription.updated": "Subscription updated",
  "subscription.canceled": "Subscription cancelled",
  "report.exported": "Report exported",
  "availability.updated": "Availability changed",
  /*
   * All three, and the old one stays.
   *
   * `member.role_changed` no longer covers custom roles, but every entry
   * written before the split still carries it — and some of those really were
   * custom-role changes. Dropping the label would render them as a raw
   * `member.role_changed` string and remove them from the filter, which is the
   * exact defect this map already carries a comment about from the decline
   * lifecycle. A retired action still needs a name for as long as its rows
   * exist.
   */
  "member.custom_role_assigned": "Custom role assigned",
  "member.custom_role_cleared": "Custom role removed",
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
  const plan = usePlan();
  const planIncludesAuditLog = plan.has("audit_log");

  const params = useParams();
  const orgId = params.orgId as string;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterAction, setFilterAction] = useState("");
  const [filterEntity, setFilterEntity] = useState("");
  /*
   * Who, and when.
   *
   * The repository and the route have accepted `userId`, `startDate` and
   * `endDate` since they were written; only this page never sent them. "Who did
   * this?" and "what happened that week?" are the two questions an audit log is
   * opened to answer, and both worked at every layer except the one with the
   * controls on it.
   */
  const [filterUser, setFilterUser] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  /**
   * People to offer in the "who" filter.
   *
   * Current members only, which is a real limitation rather than an oversight:
   * an entry written by somebody who has since left the organisation cannot be
   * selected here, though it is still in the log and still visible unfiltered.
   * Listing everyone who APPEARS in the log would need the server to aggregate
   * distinct authors, and that is a query this screen does not have.
   */
  const [members, setMembers] = useState<{ userId: string; name: string }[]>([]);
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
      if (filterUser) params.set("userId", filterUser);
      if (filterFrom) params.set("startDate", filterFrom);
      /*
       * To the END of the chosen day.
       *
       * A date input yields "2026-08-09", which `new Date()` reads as midnight
       * UTC — so an unadjusted `endDate` excludes everything that happened on
       * the day the user picked, and picking the same day for both returns an
       * empty log. Asking for the start of the NEXT day is the honest
       * inclusive-range translation.
       */
      if (filterTo) {
        const end = new Date(`${filterTo}T00:00:00`);
        end.setDate(end.getDate() + 1);
        params.set("endDate", end.toISOString());
      }

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
    // Nothing to ask for when the plan does not include the feature — the
    // route would answer 403, and the page already knows that before its
    // first render.
    if (!planIncludesAuditLog) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the log from the server on mount and whenever the filters change
    fetchLogs();
  }, [
    orgId,
    offset,
    filterAction,
    filterEntity,
    filterUser,
    filterFrom,
    filterTo,
    planIncludesAuditLog,
  ]);

  /**
   * The member list behind the "who" filter.
   *
   * Its own request, and silent on failure. `audit:view` and the member-list
   * permissions are separate grants — an admin holds both, but a custom role
   * composed with only the first would 403 here — and a filter that cannot be
   * populated must not take the log down with it. The select simply does not
   * render.
   */
  useEffect(() => {
    if (!planIncludesAuditLog) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/members`);
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled || !Array.isArray(body)) return;
        setMembers(
          body
            .map((m: { user?: { id?: string; name?: string; email?: string } }) => ({
              userId: m.user?.id ?? "",
              name: m.user?.name || m.user?.email || "Unknown",
            }))
            .filter((m: { userId: string }) => m.userId !== "")
        );
      } catch {
        /* Non-critical — the filter is simply not offered. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, planIncludesAuditLog]);


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
  if (!can("audit:view")) {
    return (
      <div className="w-full">
        <EmptyState title="The audit log is available to company admins" description="It records every change made in the organisation, so access is kept narrow." />
      </div>
    );
  }

  /*
   * Permission first, then plan — the reverse of the order the route guard
   * uses, and deliberately.
   *
   * The guard checks the plan first because that decides the STATUS CODE. A
   * page is deciding what to SAY, and the two questions have different best
   * answers: telling a member without `audit:view` that they need Enterprise
   * names a plan they cannot buy and would still not get in, while hiding the
   * real reason.
   *
   * Both checks stay. `plan.has` is known before the first render, so the page
   * no longer fires a request it knows will be refused; `planRefusal` is the
   * SERVER's answer, kept because if the two ever disagree the server wins.
   */
  if (!plan.has("audit_log") || planRefusal) {
    return (
      <div className="w-full">
        <PlanLocked
          feature="audit_log"
          title="Audit logs"
          description="Every change in the organisation is recorded either way — this is what lets you read them."
          orgId={orgId}
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      {/*
        The house header shape. This page kept `text-2xl font-bold` with no
        responsive step, so on a phone it rendered a size larger than every
        other page in the product — and had no subtitle, where every sibling
        says in one line what the screen is for.
      */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Audit log</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every change made in this organisation, newest first.
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/*
          `bg-background text-foreground` is the point. A native select with no
          background token inherits the browser's, so these rendered
          light-on-light in dark mode and the options were unreadable — the same
          defect My Tasks carries a comment about having fixed, never propagated
          here.
        */}
        <select
          aria-label="Action"
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
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
          aria-label="Entity"
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          value={filterEntity}
          onChange={(e) => {
            setFilterEntity(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All entities</option>
          {AUDIT_ENTITY_TYPES.map((value) => (
            <option key={value} value={value}>
              {AUDIT_ENTITY_LABELS[value]}
            </option>
          ))}
        </select>

        {members.length > 0 && (
          <select
            aria-label="Member"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            value={filterUser}
            onChange={(e) => {
              setFilterUser(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        )}

        <input
          type="date"
          aria-label="From"
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          value={filterFrom}
          max={filterTo || undefined}
          onChange={(e) => {
            setFilterFrom(e.target.value);
            setOffset(0);
          }}
        />
        <input
          type="date"
          aria-label="To"
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          value={filterTo}
          min={filterFrom || undefined}
          onChange={(e) => {
            setFilterTo(e.target.value);
            setOffset(0);
          }}
        />

        {/*
          Offered only when something is set. A permanent Clear button beside
          five untouched controls is noise; one that appears when there is
          something to clear is the affordance.
        */}
        {(filterAction || filterEntity || filterUser || filterFrom || filterTo) && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              setFilterAction("");
              setFilterEntity("");
              setFilterUser("");
              setFilterFrom("");
              setFilterTo("");
              setOffset(0);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Log entries */}
      {loading ? (
        <PageLoading />
      ) : (
        <Panel
          title="Entries"
          icon={ScrollText}
          count={total}
          bodyClassName="divide-y divide-border"
        >
          {entries.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="Nothing to show"
              description={
                filterAction || filterEntity
                  ? "No entries match those filters."
                  : "Changes appear here as people make them."
              }
            />
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <span
                  className={`w-fit shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${actionColor(entry.action)}`}
                >
                  {ACTION_LABELS[entry.action as AuditAction] || entry.action}
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
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </Panel>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Previous
          </button>
          <p className="text-[13px] text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
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