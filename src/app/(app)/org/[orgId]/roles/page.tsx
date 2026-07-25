/**
 * Roles Management Page (Boundary Layer)
 * 
 * Company Admin can create, edit, and delete custom roles
 * with granular permission assignments. System roles are
 * displayed but cannot be modified.
 */
"use client";

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
import { EmptyState } from "@/components/ui/empty-state";

interface Permission {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface RolePermission {
  permission: Permission;
}

interface Role {
  id: string;
  name: string;
  displayLabel: string;
  description: string | null;
  isSystemRole: boolean;
  rolePermissions: RolePermission[];
}

export default function RolesPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRoles();
    fetchPermissions();
  }, [orgId]);

  async function fetchRoles() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`);
      const data = await res.json();
      setRoles(data);
    } catch {
      setError("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }

  async function fetchPermissions() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/permissions`);
      const data = await res.json();
      setPermissions(data);
    } catch {
      // Silently fail
    }
  }

  function togglePermission(permId: string) {
    setSelectedPermissions((prev) =>
      prev.includes(permId)
        ? prev.filter((id) => id !== permId)
        : [...prev, permId]
    );
  }

  // Group permissions by category for display
  function groupedPermissions() {
    const groups: Record<string, Permission[]> = {};
    for (const perm of permissions) {
      if (!groups[perm.category]) groups[perm.category] = [];
      groups[perm.category].push(perm);
    }
    return groups;
  }

  async function onCreateRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    if (selectedPermissions.length === 0) {
      setError("Select at least one permission");
      return;
    }

    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          displayLabel: formData.get("displayLabel"),
          description: formData.get("description"),
          permissionIds: selectedPermissions,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to create role");
        return;
      }

      setShowCreate(false);
      setSelectedPermissions([]);
      (event.target as HTMLFormElement).reset();
      fetchRoles();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onUpdateRole(
    event: React.FormEvent<HTMLFormElement>,
    roleId: string
  ) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/roles/${roleId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayLabel: formData.get("displayLabel"),
            description: formData.get("description"),
            permissionIds:
              selectedPermissions.length > 0
                ? selectedPermissions
                : undefined,
          }),
        }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to update role");
        return;
      }

      setEditingId(null);
      setSelectedPermissions([]);
      fetchRoles();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onDeleteRole(roleId: string) {
    if (!confirm("Are you sure you want to delete this role?")) return;
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/roles/${roleId}`,
        { method: "DELETE" }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to delete role");
        return;
      }

      fetchRoles();
    } catch {
      setError("Something went wrong");
    }
  }

  function startEditing(role: Role) {
    setEditingId(role.id);
    setSelectedPermissions(
      role.rolePermissions.map((rp) => rp.permission.id)
    );
  }

  function startCreating() {
    setShowCreate(true);
    setSelectedPermissions([]);
  }

  if (loading) return <PageLoading />;

  const grouped = groupedPermissions();

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Roles</h2>
        <Button onClick={() => (showCreate ? setShowCreate(false) : startCreating())}>
          {showCreate ? "Cancel" : "Create Role"}
        </Button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* Create role form */}
      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New Custom Role</CardTitle>
            <CardDescription>
              Define a role with specific permissions
            </CardDescription>
          </CardHeader>
          <form onSubmit={onCreateRole}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">Internal Name</Label>
                <Input
                  id="create-name"
                  name="name"
                  placeholder="e.g. shift_lead"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-label">Display Label</Label>
                <Input
                  id="create-label"
                  name="displayLabel"
                  placeholder="e.g. Shift Lead"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-desc">Description</Label>
                <Input
                  id="create-desc"
                  name="description"
                  placeholder="What this role is for"
                />
              </div>

              {/* Permission toggles grouped by category */}
              <div className="space-y-4">
                <Label>Permissions</Label>
                {Object.entries(grouped).map(([category, perms]) => (
                  <div key={category} className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium capitalize">
                      {category}
                    </p>
                    <div className="space-y-1">
                      {perms.map((perm) => (
                        <label
                          key={perm.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPermissions.includes(perm.id)}
                            onChange={() => togglePermission(perm.id)}
                          />
                          <span>{perm.description}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <Button type="submit">Create Role</Button>
            </CardContent>
          </form>
        </Card>
      )}

      {/* Roles list */}
      {roles.length === 0 ? (
        <EmptyState title="No custom roles yet" description="Create your first role to define granular permissions." />
      ) : (
        <div className="space-y-4">
          {roles.map((role) => (
            <Card key={role.id}>
              {editingId === role.id ? (
                <form onSubmit={(e) => onUpdateRole(e, role.id)}>
                  <CardContent className="space-y-4 pt-6">
                    <div className="space-y-2">
                      <Label>Display Label</Label>
                      <Input
                        name="displayLabel"
                        defaultValue={role.displayLabel}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        name="description"
                        defaultValue={role.description || ""}
                      />
                    </div>
                    <div className="space-y-4">
                      <Label>Permissions</Label>
                      {Object.entries(grouped).map(([category, perms]) => (
                        <div key={category} className="rounded-md border p-3">
                          <p className="mb-2 text-sm font-medium capitalize">
                            {category}
                          </p>
                          <div className="space-y-1">
                            {perms.map((perm) => (
                              <label
                                key={perm.id}
                                className="flex items-center gap-2 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedPermissions.includes(perm.id)}
                                  onChange={() => togglePermission(perm.id)}
                                />
                                <span>{perm.description}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm">Save</Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(null);
                          setSelectedPermissions([]);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </form>
              ) : (
                <>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          {role.displayLabel}
                          {role.isSystemRole && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                              System
                            </span>
                          )}
                        </CardTitle>
                        <CardDescription>
                          {role.name}
                          {role.description && ` — ${role.description}`}
                        </CardDescription>
                      </div>
                      {!role.isSystemRole && (
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => startEditing(role)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onDeleteRole(role.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-2 text-sm font-medium">
                      {role.rolePermissions.length} permission
                      {role.rolePermissions.length !== 1 ? "s" : ""}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {role.rolePermissions.map((rp) => (
                        <span
                          key={rp.permission.id}
                          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                        >
                          {rp.permission.name}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}