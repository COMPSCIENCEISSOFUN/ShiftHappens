/**
 * Members Management Page (Boundary Layer)
 *
 * Company Admin can view all org members in a table,
 * invite new users, update roles, assign departments,
 * and activate/deactivate members.
 * Self-demotion protection: current user cannot change
 * their own role or deactivate themselves.
 *
 * Phase 12 visual overhaul — stat tiles, avatar rows,
 * responsive layout, full-width.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Mail, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile } from "@/components/ui/stat-tile";
import { SYSTEM_ROLE_LABELS, EMPLOYMENT_TYPE_LABELS, DEFAULT_EMPLOYMENT_TYPE } from "@/lib/role-config";
import {
  SENIORITY_LEVELS,
  SENIORITY_LABEL,
  type SeniorityAssessment,
} from "@/lib/seniority";
import { filterMembers, hasActiveFilters as checkActiveFilters } from "@/lib/member-filters";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Member {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  customRole: { id: string; name: string; displayLabel: string } | null;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  departmentMemberships: {
    department: { id: string; name: string };
  }[];
}

interface CustomRole {
  id: string;
  name: string;
  displayLabel: string;
  isSystemRole: boolean;
}

interface Department {
  id: string;
  name: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  acceptedAt: string | null;
  expires: string;
  invitedBy: { name: string | null; email: string };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Two-letter avatar from name. */
function initials(name: string | null): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_COLOURS = [
  "bg-indigo-600", "bg-cyan-600", "bg-emerald-600", "bg-amber-600",
  "bg-rose-600", "bg-purple-600", "bg-teal-600", "bg-orange-600",
];
function avatarColour(name: string | null): string {
  if (!name) return "bg-gray-400";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLOURS[Math.abs(h) % AVATAR_COLOURS.length];
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function MembersPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [members, setMembers] = useState<Member[]>([]);
  /**
   * Seniority, keyed by MEMBERSHIP id — not user id like the other maps here.
   * It comes from its own endpoint rather than the members list because the
   * level depends on a department scope the list has no opinion about; this
   * page asks for the org-wide figure and says so.
   */
  const [seniority, setSeniority] = useState<Record<string, SeniorityAssessment>>({});
  const [departments, setDepartments] = useState<Department[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState("staff");
  const [inviting, setInviting] = useState(false);
  const [rolePopoverFor, setRolePopoverFor] = useState<string | null>(null);

  // Close custom-role popover on outside click
  useEffect(() => {
    if (!rolePopoverFor) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-role-popover]")) {
        setRolePopoverFor(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [rolePopoverFor]);

  // Search & filter state
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [filterEmpType, setFilterEmpType] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  useEffect(() => {
    fetchMembers();
    fetchDepartments();
    fetchCustomRoles();
    fetchInvitations();
    fetchCurrentUser();
    fetchSeniority();
  }, [orgId]);

  async function fetchCurrentUser() {
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const data = await res.json();
        setCurrentUserId(data.id);
      }
    } catch { /* non-critical */ }
  }

  async function fetchMembers() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`);
      const data = await res.json();

      // A 403 body is `{ error }`, not an array. Without this every `.filter`
      // below threw and the whole page rendered as a blank screen.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load members"
        );
        setMembers([]);
        return;
      }

      setMembers(data);
      setError(null);
    } catch {
      setError("Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSeniority() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/seniority`);
      const data = await res.json();
      if (res.ok && data?.assessments) setSeniority(data.assessments);
    } catch { /* non-critical — the column falls back to "—" */ }
  }

  async function onUpdateSeniority(userId: string, value: string) {
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/members/${userId}/seniority`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // "" is the UI's way of saying "derive it" and has to reach the API
          // as null — an empty string is not a level and would be rejected.
          body: JSON.stringify({ seniorityOverride: value === "" ? null : value }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to update seniority");
        return;
      }
      await fetchSeniority();
    } catch {
      setError("Failed to update seniority");
    }
  }

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setDepartments(data);
    } catch { /* non-critical */ }
  }

  async function fetchCustomRoles() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`);
      const all = await res.json();
      if (res.ok && Array.isArray(all)) {
        setCustomRoles((all as CustomRole[]).filter((r) => !r.isSystemRole));
      }
    } catch { /* non-critical */ }
  }

  async function fetchInvitations() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations`);
      const data = await res.json();

      // Same shape trap as fetchMembers — `pendingInvitations` filters this list.
      if (res.ok && Array.isArray(data)) setInvitations(data);
      else setInvitations([]);
    } catch { /* non-critical */ }
  }

  async function onInviteUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Two clicks used to send the invitee two emails and leave a duplicate
    // pending invitation behind. Checked here as well as on the button because
    // a fast double click lands before React repaints `disabled`.
    if (inviting) return;

    const form = event.currentTarget;
    setInviting(true);
    setError(null);
    setSuccess(null);
    const formData = new FormData(form);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.get("email"),
          role: formData.get("role"),
          departmentId: formData.get("departmentId") || undefined,
          employmentType: formData.get("role") === "staff" ? (formData.get("employmentType") || DEFAULT_EMPLOYMENT_TYPE) : undefined,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setError(result.error || "Failed to send invitation"); return; }
      setSuccess(`Invitation sent to ${formData.get("email")}`);
      setShowInvite(false);
      form.reset();
      fetchInvitations();
    } catch {
      setError("Something went wrong");
    } finally {
      setInviting(false);
    }
  }

  async function onToggleStatus(userId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}/toggle-status`, { method: "POST" });
      if (!res.ok) { const r = await res.json(); setError(r.error || "Failed to update status"); return; }
      fetchMembers();
    } catch { setError("Something went wrong"); }
  }

  async function onUpdateRole(userId: string, newRole: string, departmentIds?: string[]) {
    setError(null);
    try {
      const body: { role: string; departmentIds?: string[] } = { role: newRole };
      if (departmentIds !== undefined) body.departmentIds = departmentIds;
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const r = await res.json(); setError(r.error || "Failed to update"); return; }
      fetchMembers();
    } catch { setError("Something went wrong"); }
  }

  async function onUpdateDepartment(userId: string, currentRole: string, deptId: string) {
    const departmentIds = deptId ? [deptId] : [];
    await onUpdateRole(userId, currentRole, departmentIds);
  }

  async function onUpdateEmploymentType(userId: string, empType: string) {
    setError(null);
    try {
      const member = members.find((m) => m.user.id === userId);
      if (!member) return;
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: member.role, employmentType: empType }),
      });
      if (!res.ok) { const r = await res.json(); setError(r.error || "Failed to update"); return; }
      fetchMembers();
    } catch { setError("Something went wrong"); }
  }

  async function onUpdateCustomRole(userId: string, customRoleId: string | null) {
    setError(null);
    try {
      const member = members.find((m) => m.user.id === userId);
      if (!member) return;
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: member.role, customRoleId }),
      });
      if (!res.ok) { const r = await res.json(); setError(r.error || "Failed to update custom role"); return; }
      setRolePopoverFor(null);
      fetchMembers();
    } catch { setError("Something went wrong"); }
  }

  // ── Stat counts (always computed from full list, not filtered) ──
  const activeCount = members.filter((m) => m.status === "active").length;
  const inactiveCount = members.filter((m) => m.status !== "active").length;
  const pendingInvitations = invitations.filter((i) => !i.acceptedAt);

  const roleBreakdown = {
    admins: members.filter((m) => m.role === "company_admin").length,
    managers: members.filter((m) => m.role === "manager").length,
    staff: members.filter((m) => m.role === "staff").length,
  };
  const ftCount = members.filter((m) => m.role === "staff" && m.employmentType === "full_time").length;
  const casualCount = members.filter((m) => m.role === "staff" && (m.employmentType === DEFAULT_EMPLOYMENT_TYPE || !m.employmentType)).length;

  // ── Filter members ──
  const currentFilters = { search, role: filterRole, employmentType: filterEmpType, departmentId: filterDept, status: filterStatus };
  const hasActiveFilters = checkActiveFilters(currentFilters);
  const filteredMembers = filterMembers(members, currentFilters);

  if (loading) return <PageLoading />;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Members</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Manage your organisation&apos;s team members and invitations
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={`/org/${orgId}/members/import`}>
            <button className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground">
              Import Members
            </button>
          </Link>
          <button
            onClick={() => setShowInvite(!showInvite)}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${showInvite ? "border border-border bg-card text-muted-foreground hover:text-foreground" : "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"}`}
          >
            {showInvite ? "Cancel" : "+ Invite User"}
          </button>
        </div>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile label="Team" value={members.length} detail={`${roleBreakdown.admins} admin · ${roleBreakdown.managers} mgr · ${roleBreakdown.staff} staff`} accentColour="rgba(99,102,241,.08)" />
        <StatTile label="Pending" value={pendingInvitations.length} detail="invitations" accentColour="rgba(245,158,11,.08)" valueColour={pendingInvitations.length > 0 ? "text-amber-600 dark:text-amber-400" : ""} />
        <StatTile label="Employment" value={roleBreakdown.staff} detail={`${ftCount} full-time · ${casualCount} casual`} accentColour="rgba(59,130,246,.08)" />
        <StatTile label="Status" value={activeCount} detail={`${activeCount} active · ${inactiveCount} inactive`} accentColour="rgba(34,197,94,.08)" valueColour="text-green-600 dark:text-green-400" />
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* ── Search & Filters ── */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          >
            <option value="">All roles</option>
            {Object.entries(SYSTEM_ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={filterEmpType}
            onChange={(e) => setFilterEmpType(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          >
            <option value="">All types</option>
            {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          >
            <option value="">All depts</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          >
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          {hasActiveFilters && (
            <button
              onClick={() => { setSearch(""); setFilterRole(""); setFilterEmpType(""); setFilterDept(""); setFilterStatus(""); }}
              className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Result count ── */}
      {hasActiveFilters && (
        <p className="mb-2 text-[12px] text-muted-foreground">
          Showing {filteredMembers.length} of {members.length} member{members.length !== 1 ? "s" : ""}
        </p>
      )}

      {/* ── Invite form ── */}
      {showInvite && (
        <div className="mb-4 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[13px] font-semibold">Invite User</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Send an invitation email to add a new member</p>
          </div>
          <form onSubmit={onInviteUser} className="p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email" className="text-xs">Email</Label>
                <Input id="invite-email" name="email" type="email" placeholder="name@example.com" required className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role" className="text-xs">Role</Label>
                <select id="invite-role" name="role" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="staff">Staff</option>
                  <option value="manager">Manager</option>
                </select>
              </div>
              {inviteRole === "staff" && (
                <div className="space-y-1.5">
                  <Label htmlFor="invite-emptype" className="text-xs">Employment Type</Label>
                  <select id="invite-emptype" name="employmentType" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue={DEFAULT_EMPLOYMENT_TYPE}>
                    {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="invite-dept" className="text-xs">Department</Label>
                <select id="invite-dept" name="departmentId" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue="">
                  <option value="">None</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button type="submit" disabled={inviting} className="mt-3 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60">
              {inviting ? "Sending…" : "Send Invitation"}
            </button>
          </form>
        </div>
      )}

      {/* ── Members table ── */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Desktop table */}
        <div className="hidden sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Member</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Role</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Type</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Seniority</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Department</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters ? "No members match your filters" : "No members yet"}
                    </p>
                    {hasActiveFilters && (
                      <button
                        onClick={() => { setSearch(""); setFilterRole(""); setFilterEmpType(""); setFilterDept(""); setFilterStatus(""); }}
                        className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                      >
                        Clear all filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
              filteredMembers.map((member) => {
                const currentDeptId = member.departmentMemberships[0]?.department.id || "";
                const isSelf = member.user.id === currentUserId;
                return (
                  <tr key={member.id} className={`border-b border-border last:border-b-0 transition-colors hover:bg-muted/20 ${member.status !== "active" ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${avatarColour(member.user.name)}`}>
                          {initials(member.user.name)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-[13px] font-medium">{member.user.name || "Unnamed"}</p>
                            {isSelf && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">you</span>
                            )}
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">{member.user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <select
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                          value={member.role}
                          onChange={(e) => onUpdateRole(member.user.id, e.target.value)}
                          disabled={isSelf}
                          title={isSelf ? "Cannot change your own role" : undefined}
                        >
                          <option value="staff">Staff</option>
                          <option value="manager">Manager</option>
                          <option value="company_admin">Admin</option>
                        </select>
                        {/* Custom role tag — only for non-admins */}
                        {member.role !== "company_admin" && (
                          member.customRole ? (
                            <span className="group inline-flex w-fit items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/40 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">
                              <Sparkles className="h-3 w-3 shrink-0 text-purple-500 dark:text-purple-400" aria-hidden="true" />
                              {member.customRole.displayLabel}
                              {!isSelf && (
                                <button
                                  onClick={() => onUpdateCustomRole(member.user.id, null)}
                                  className="ml-0.5 hidden rounded-full text-purple-400 transition-colors hover:text-purple-600 dark:hover:text-purple-200 group-hover:inline"
                                  title="Remove custom role"
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ) : customRoles.length > 0 && !isSelf ? (
                            <div className="relative" data-role-popover>
                              <button
                                onClick={() => setRolePopoverFor(rolePopoverFor === member.id ? null : member.id)}
                                className="text-[10px] font-medium text-purple-500 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-200"
                              >
                                + assign role
                              </button>
                              {rolePopoverFor === member.id && (
                                <div className="absolute left-0 top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
                                  <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border">
                                    Custom Roles
                                  </div>
                                  {customRoles.map((cr) => (
                                    <button
                                      key={cr.id}
                                      onClick={() => onUpdateCustomRole(member.user.id, cr.id)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
                                    >
                                      <Sparkles className="h-3 w-3 shrink-0 text-purple-500" aria-hidden="true" />
                                      {cr.displayLabel}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : null
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {member.role === "staff" ? (
                        <select
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                          value={member.employmentType || DEFAULT_EMPLOYMENT_TYPE}
                          onChange={(e) => onUpdateEmploymentType(member.user.id, e.target.value)}
                        >
                          {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {/*
                        Admins are not rostered, so a level for them would be a
                        number with nothing behind it and nothing reading it.
                      */}
                      {member.role === "company_admin" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          <select
                            aria-label={`Seniority for ${member.user.name ?? member.user.email}`}
                            className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                            value={
                              seniority[member.id]?.overridden
                                ? seniority[member.id].level
                                : ""
                            }
                            onChange={(e) => onUpdateSeniority(member.user.id, e.target.value)}
                          >
                            {/* The empty option is the DEFAULT, not a blank —
                                it names what happens when nobody overrides. */}
                            <option value="">
                              Auto{seniority[member.id]
                                ? ` — ${SENIORITY_LABEL[seniority[member.id].level] ?? ""}`
                                : ""}
                            </option>
                            {SENIORITY_LEVELS.map((level) => (
                              <option key={level} value={level}>
                                Pin to {SENIORITY_LABEL[level]}
                              </option>
                            ))}
                          </select>
                          {/*
                            The explanation is the point. A level that decides
                            who gets rostered must never be an unexplained
                            assertion, so the count behind it is always shown.
                          */}
                          {seniority[member.id] && (
                            <p className="text-[10px] text-muted-foreground">
                              {seniority[member.id].explanation}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                        value={currentDeptId}
                        onChange={(e) => onUpdateDepartment(member.user.id, member.role, e.target.value)}
                      >
                        <option value="">None</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge value={member.status} palette="membershipStatus" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onToggleStatus(member.user.id)}
                        disabled={isSelf}
                        title={isSelf ? "Cannot deactivate yourself" : undefined}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${member.status === "active" ? "border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950" : "border-green-200 dark:border-green-900 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950"} disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {member.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                );
              })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile card layout */}
        <div className="block divide-y divide-border sm:hidden">
          {filteredMembers.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters ? "No members match your filters" : "No members yet"}
              </p>
              {hasActiveFilters && (
                <button
                  onClick={() => { setSearch(""); setFilterRole(""); setFilterEmpType(""); setFilterDept(""); setFilterStatus(""); }}
                  className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
          filteredMembers.map((member) => {
            const currentDeptId = member.departmentMemberships[0]?.department.id || "";
            const isSelf = member.user.id === currentUserId;
            return (
              <div key={member.id} className={`p-4 ${member.status !== "active" ? "opacity-50" : ""}`}>
                <div className="flex items-start gap-3">
                  <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${avatarColour(member.user.name)}`}>
                    {initials(member.user.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{member.user.name || "Unnamed"}</p>
                      {isSelf && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">you</span>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{member.user.email}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <StatusBadge value={member.role} palette="role" />
                      {member.role === "staff" && member.employmentType && (
                        <span className="rounded-full bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                          {EMPLOYMENT_TYPE_LABELS[member.employmentType || DEFAULT_EMPLOYMENT_TYPE]}
                        </span>
                      )}
                      {member.customRole && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/40 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">
                          <Sparkles className="h-3 w-3 shrink-0 text-purple-500 dark:text-purple-400" aria-hidden="true" />
                          {member.customRole.displayLabel}
                        </span>
                      )}
                      <StatusBadge value={member.status} palette="membershipStatus" />
                      {member.departmentMemberships[0] && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {member.departmentMemberships[0].department.name}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <select
                        className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs"
                        value={member.role}
                        onChange={(e) => onUpdateRole(member.user.id, e.target.value)}
                        disabled={isSelf}
                      >
                        <option value="staff">Staff</option>
                        <option value="manager">Manager</option>
                        <option value="company_admin">Admin</option>
                      </select>
                      <button
                        onClick={() => onToggleStatus(member.user.id)}
                        disabled={isSelf}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${member.status === "active" ? "border-red-200 dark:border-red-900 text-red-600 dark:text-red-400" : "border-green-200 dark:border-green-900 text-green-600 dark:text-green-400"} disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {member.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
          )}
        </div>
      </div>

      {/* ── Pending invitations ── */}
      {pendingInvitations.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Pending Invitations</h3>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {/* Desktop */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Role</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Invited by</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvitations.map((invitation) => (
                    <tr key={invitation.id} className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300">
                            <Mail className="h-3.5 w-3.5" />
                          </div>
                          <span className="text-[13px] font-medium">{invitation.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3"><StatusBadge value={invitation.role} palette="role" /></td>
                      <td className="px-4 py-3 text-[13px] text-muted-foreground">{invitation.invitedBy.name || invitation.invitedBy.email}</td>
                      <td className="px-4 py-3 text-right text-[13px] text-muted-foreground">{new Date(invitation.expires).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile */}
            <div className="block divide-y divide-border sm:hidden">
              {pendingInvitations.map((invitation) => (
                <div key={invitation.id} className="flex items-center justify-between p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{invitation.email}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <StatusBadge value={invitation.role} palette="role" />
                      <span className="text-[10px] text-muted-foreground">expires {new Date(invitation.expires).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
