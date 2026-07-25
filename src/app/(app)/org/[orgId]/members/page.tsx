/**
 * Members Management Page (Boundary Layer)
 *
 * Company Admin can view all org members in a table,
 * invite new users, update roles, assign departments,
 * and activate/deactivate members.
 * Self-demotion protection: current user cannot change
 * their own role or deactivate themselves.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";

interface Member {
  id: string;
  role: string;
  status: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  departmentMemberships: {
    department: { id: string; name: string };
  }[];
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

export default function MembersPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    fetchMembers();
    fetchDepartments();
    fetchInvitations();
    fetchCurrentUser();
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
      setMembers(await res.json());
    } catch {
      setError("Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      if (res.ok) setDepartments(await res.json());
    } catch { /* non-critical */ }
  }

  async function fetchInvitations() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations`);
      setInvitations(await res.json());
    } catch { /* non-critical */ }
  }

  async function onInviteUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.get("email"),
          role: formData.get("role"),
          departmentId: formData.get("departmentId") || undefined,
        }),
      });
      const result = await res.json();
      if (!res.ok) { setError(result.error || "Failed to send invitation"); return; }
      setSuccess(`Invitation sent to ${formData.get("email")}`);
      setShowInvite(false);
      (event.target as HTMLFormElement).reset();
      fetchInvitations();
    } catch {
      setError("Something went wrong");
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

  const activeMembers = members.filter((m) => m.status === "active");
  const inactiveMembers = members.filter((m) => m.status !== "active");
  const pendingInvitations = invitations.filter((i) => !i.acceptedAt);

  if (loading) return <PageLoading />;

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Members</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {activeMembers.length} active · {inactiveMembers.length} inactive
            {pendingInvitations.length > 0 && ` · ${pendingInvitations.length} pending`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/org/${orgId}/members/import`}>
            <Button variant="outline">Import members</Button>
          </Link>
          <Button onClick={() => setShowInvite(!showInvite)}>
            {showInvite ? "Cancel" : "Invite User"}
          </Button>
        </div>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {showInvite && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Invite User</CardTitle>
            <CardDescription>Send an invitation email to add a new member</CardDescription>
          </CardHeader>
          <form onSubmit={onInviteUser}>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" name="email" type="email" placeholder="name@example.com" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-role">Role</Label>
                  <select id="invite-role" name="role" className="w-full rounded-md border px-3 py-2 text-sm bg-background" defaultValue="staff">
                    <option value="staff">Staff</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-dept">Department</Label>
                  <select id="invite-dept" name="departmentId" className="w-full rounded-md border px-3 py-2 text-sm bg-background" defaultValue="">
                    <option value="">None</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <Button type="submit">Send Invitation</Button>
            </CardContent>
          </form>
        </Card>
      )}

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="text-left font-medium px-4 py-3 text-muted-foreground">Name</th>
              <th className="text-left font-medium px-4 py-3 text-muted-foreground">Role</th>
              <th className="text-left font-medium px-4 py-3 text-muted-foreground">Department</th>
              <th className="text-left font-medium px-4 py-3 text-muted-foreground">Status</th>
              <th className="text-right font-medium px-4 py-3 text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const currentDeptId = member.departmentMemberships[0]?.department.id || "";
              const isSelf = member.user.id === currentUserId;
              return (
                <tr key={member.id} className={`border-b last:border-b-0 transition-colors hover:bg-muted/20 ${member.status !== "active" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div>
                        <p className="font-medium">{member.user.name || "Unnamed"}</p>
                        <p className="text-xs text-muted-foreground">{member.user.email}</p>
                      </div>
                      {isSelf && (
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">you</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={member.role} palette="role" />
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded-md border px-2 py-1 text-xs bg-background"
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
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <select
                        className="rounded-md border px-2 py-1 text-xs bg-background"
                        value={member.role}
                        onChange={(e) => onUpdateRole(member.user.id, e.target.value)}
                        disabled={isSelf}
                        title={isSelf ? "Cannot change your own role" : undefined}
                      >
                        <option value="staff">Staff</option>
                        <option value="manager">Manager</option>
                        <option value="company_admin">Admin</option>
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => onToggleStatus(member.user.id)}
                        disabled={isSelf}
                        title={isSelf ? "Cannot deactivate yourself" : undefined}
                      >
                        {member.status === "active" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pendingInvitations.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold mb-3">Pending Invitations</h3>
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Email</th>
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Role</th>
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Invited by</th>
                  <th className="text-right font-medium px-4 py-3 text-muted-foreground">Expires</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map((invitation) => (
                  <tr key={invitation.id} className="border-b last:border-b-0">
                    <td className="px-4 py-3 font-medium">{invitation.email}</td>
                    <td className="px-4 py-3"><StatusBadge value={invitation.role} palette="role" /></td>
                    <td className="px-4 py-3 text-muted-foreground">{invitation.invitedBy.name || invitation.invitedBy.email}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{new Date(invitation.expires).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
