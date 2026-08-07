"use client";

import { useEffect, useRef } from "react";
import {
  Building2,
  Briefcase,
  CalendarClock,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserMinus,
  UserCheck,
  X,
} from "lucide-react";
import {
  EMPLOYMENT_TYPE_LABELS,
  DEFAULT_EMPLOYMENT_TYPE,
  SYSTEM_ROLE_LABELS,
} from "@/lib/role-config";
import { ContractedDaysEditor } from "@/components/members/contracted-days-editor";
import { SENIORITY_LEVELS, SENIORITY_LABEL, type SeniorityAssessment } from "@/lib/seniority";

export interface DrawerMember {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  customRole: { id: string; name: string; displayLabel: string } | null;
  user: { id: string; name: string | null; email: string };
  departmentMemberships: { department: { id: string; name: string } }[];
}

/**
 * Every editable setting for one member, in one place.
 *
 * ## Why the table stopped doing this itself
 *
 * Each row used to carry three dropdowns plus a checkbox per department — with
 * eleven members and three departments, around seventy-seven controls on screen
 * at once, and every row three lines tall because the department column is a
 * vertical stack that grows as departments are added. The table was never a
 * thing you could read; it was permanently in edit mode for everybody.
 *
 * The mobile view on the same page had already solved this — badges, one line
 * per member — so the two views disagreed about what the page was for. The
 * table now matches it and the editing moved here.
 *
 * ## Changes apply immediately, and there is no Save button
 *
 * Each control calls the endpoint it has always called and the list refetches.
 * A Save button would imply a batch that does not exist: role, employment type,
 * custom role, seniority and departments are five different requests to three
 * different routes, and pretending otherwise would mean either faking it or
 * building a dirty-state model that can half-fail. An immediate change that
 * reports its own error is honest; a Save that silently applied four of five
 * would not be.
 */
export function MemberEditDrawer({
  orgId,
  member,
  departments,
  customRoles,
  seniority,
  isSelf,
  canUpdateRole,
  canUpdateSeniority,
  canDeactivate,
  canSetContractedDays,
  onRequestAvailabilityReview,
  onUpdateRole,
  onUpdateEmploymentType,
  onUpdateCustomRole,
  onUpdateSeniority,
  onToggleDepartment,
  onToggleStatus,
  onClose,
}: {
  orgId: string;
  member: DrawerMember;
  departments: { id: string; name: string }[];
  customRoles: { id: string; displayLabel: string }[];
  seniority?: SeniorityAssessment;
  isSelf: boolean;
  canUpdateRole: boolean;
  canUpdateSeniority: boolean;
  canDeactivate: boolean;
  /** Whether this caller may set contracted days — `members:set_contracted_days`. */
  canSetContractedDays: boolean;
  /** The existing availability-review nudge, offered for casual members. */
  onRequestAvailabilityReview?: (userId: string) => void;
  onUpdateRole: (userId: string, role: string) => void;
  onUpdateEmploymentType: (userId: string, empType: string) => void;
  onUpdateCustomRole: (userId: string, customRoleId: string | null) => void;
  onUpdateSeniority: (userId: string, value: string) => void;
  onToggleDepartment: (
    userId: string,
    currentRole: string,
    deptId: string,
    current: string[]
  ) => void;
  onToggleStatus: (userId: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const memberDeptIds = member.departmentMemberships.map((dm) => dm.department.id);
  const name = member.user.name || member.user.email;
  const initials = (member.user.name || member.user.email)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  // Escape closes. A panel that covers the row it came from and can only be
  // dismissed by aiming at a small × is a trap for anyone not using a mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves into the panel on open, so the next Tab lands on its first
  // control rather than continuing from wherever the table left off.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <>
      {/*
        The backdrop is a real button rather than a div with onClick: clicking
        away is the most common way to dismiss a panel and it should be
        reachable without a mouse. Labelled, because "close" said by a
        full-screen element with no text reads as nothing at all.
      */}
      <button
        type="button"
        aria-label={`Close ${name}`}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-black/20 dark:bg-black/40"
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${name}`}
        tabIndex={-1}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-border bg-card shadow-xl outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/30 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name}</p>
              <p className="truncate text-[12px] text-muted-foreground">
                {member.user.email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* ── Role ─────────────────────────────────────────── */}
          <div>
            <label
              htmlFor="drawer-role"
              className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Role
            </label>
            <select
              id="drawer-role"
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
              value={member.role}
              onChange={(e) => onUpdateRole(member.user.id, e.target.value)}
              disabled={isSelf || !canUpdateRole}
            >
              <option value="staff">Staff</option>
              <option value="manager">Manager</option>
              <option value="company_admin">Admin</option>
            </select>
            {isSelf && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                You cannot change your own role.
              </p>
            )}
          </div>

          {/* ── Custom role ──────────────────────────────────── */}
          {member.role !== "company_admin" && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Custom role
              </p>
              {member.customRole ? (
                <div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {member.customRole.displayLabel}
                    </span>
                    {!isSelf && canUpdateRole && (
                      <button
                        type="button"
                        onClick={() => onUpdateCustomRole(member.user.id, null)}
                        className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {/*
                    Said out loud because the chip on its own implies the
                    opposite. `effectivePermissions` REPLACES the system bundle
                    when a custom role is present — a manager holding a role with
                    three permissions ticked has three permissions, not the
                    manager bundle plus three. That is deliberate (it is the only
                    way a role can take something away) but it is invisible, and
                    a chip sitting next to "Manager" reads as an addition.
                  */}
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Replaces the {SYSTEM_ROLE_LABELS[member.role] ?? member.role}{" "}
                    permissions rather than adding to them — this member can do
                    exactly what this role allows.
                  </p>
                </div>
              ) : customRoles.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No custom roles defined.
                </p>
              ) : (
                <select
                  aria-label="Assign a custom role"
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
                  value=""
                  disabled={isSelf || !canUpdateRole}
                  onChange={(e) =>
                    e.target.value && onUpdateCustomRole(member.user.id, e.target.value)
                  }
                >
                  <option value="">Assign a custom role…</option>
                  {customRoles.map((cr) => (
                    <option key={cr.id} value={cr.id}>
                      {cr.displayLabel}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* ── Employment type ──────────────────────────────── */}
          {member.role === "staff" && (
            <div>
              <label
                htmlFor="drawer-emptype"
                className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
                Employment type
              </label>
              <select
                id="drawer-emptype"
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
                value={member.employmentType || DEFAULT_EMPLOYMENT_TYPE}
                onChange={(e) =>
                  onUpdateEmploymentType(member.user.id, e.target.value)
                }
                disabled={!canUpdateRole}
              >
                {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ── Contracted days ──────────────────────────────── */}
          {/*
            The screen for the endpoint that had none. `PUT
            .../contracted-days` shipped tested and unreachable, so the only
            way to set anybody's working days was curl — while full-time staff
            had just lost the ability to set their own.

            Rostering only, so admins are excluded: `canBeRostered` keeps
            company_admins off shifts entirely, which makes a contract of days
            for one a field with nothing to act on it.
          */}
          {canSetContractedDays && member.role !== "company_admin" && (
            <div>
              <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                Working days
              </span>
              <ContractedDaysEditor
                orgId={orgId}
                userId={member.user.id}
                employmentType={member.employmentType}
                memberName={member.user.name || member.user.email}
                onRequestReview={onRequestAvailabilityReview}
              />
            </div>
          )}

          {/* ── Seniority ────────────────────────────────────── */}
          {member.role !== "company_admin" && (
            <div>
              <label
                htmlFor="drawer-seniority"
                className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                Seniority
              </label>
              <select
                id="drawer-seniority"
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
                value={seniority?.overridden ? seniority.level : ""}
                disabled={!canUpdateSeniority}
                onChange={(e) => onUpdateSeniority(member.user.id, e.target.value)}
              >
                <option value="">
                  Auto{seniority ? ` — ${SENIORITY_LABEL[seniority.level] ?? ""}` : ""}
                </option>
                {SENIORITY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    Pin to {SENIORITY_LABEL[level]}
                  </option>
                ))}
              </select>
              {/*
                The explanation is the point, and it survived the move out of
                the table. A level that decides who gets rostered must never be
                an unexplained assertion.
              */}
              {seniority && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {seniority.explanation}
                </p>
              )}
            </div>
          )}

          {/* ── Departments ──────────────────────────────────── */}
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
              Departments
            </p>
            {departments.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No departments defined.
              </p>
            ) : (
              <div className="space-y-1.5">
                {/*
                  A checkbox per department, not a select. A member can belong
                  to several — the engine has always taken the union — and a
                  select could only ever express one.

                  Presented as selectable rows rather than bare boxes: the whole
                  row is the target, which is easier to hit than a 14px square,
                  and a selected department reads at a glance instead of needing
                  the tick to be found.
                */}
                {departments.map((d) => {
                  const selected = memberDeptIds.includes(d.id);
                  return (
                    <label
                      key={d.id}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                        canUpdateRole ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                      } ${
                        selected
                          ? "border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200"
                          : "border-border hover:border-indigo-300 hover:bg-muted/40 dark:hover:border-indigo-700"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 rounded border-border accent-indigo-600 disabled:opacity-40"
                        disabled={!canUpdateRole}
                        checked={selected}
                        onChange={() =>
                          onToggleDepartment(
                            member.user.id,
                            member.role,
                            d.id,
                            memberDeptIds
                          )
                        }
                      />
                      <span className="truncate">{d.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Status ─────────────────────────────────────────── */}
        {canDeactivate && (
          <div className="mt-auto border-t border-border px-5 py-4">
            <button
              type="button"
              onClick={() => onToggleStatus(member.user.id)}
              disabled={isSelf}
              title={isSelf ? "Cannot deactivate yourself" : undefined}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                member.status === "active"
                  ? "border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                  : "border-green-200 text-green-600 hover:bg-green-50 dark:border-green-900 dark:text-green-400 dark:hover:bg-green-950"
              }`}
            >
              {member.status === "active" ? (
                <>
                  <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                  Deactivate
                </>
              ) : (
                <>
                  <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Reactivate
                </>
              )}
            </button>
            {isSelf && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                You cannot deactivate yourself.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
