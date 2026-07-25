/**
 * Departments List Page (Boundary Layer)
 * 
 * Displays all departments in the organization with member counts.
 * Company Admin can create, edit, and delete departments.
 * Managers can only view their assigned departments.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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

interface Department {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  _count: { departmentMemberships: number };
}

export default function DepartmentsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDepartments();
  }, [orgId]);

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const data = await res.json();
      setDepartments(data);
    } catch {
      setError("Failed to load departments");
    } finally {
      setLoading(false);
    }
  }

  async function onCreateDepartment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          description: formData.get("description") || undefined,
          color: formData.get("color") || undefined,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to create department");
        return;
      }

      setShowCreate(false);
      (event.target as HTMLFormElement).reset();
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onUpdateDepartment(
    event: React.FormEvent<HTMLFormElement>,
    deptId: string
  ) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deptId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.get("name"),
            description: formData.get("description") || undefined,
            color: formData.get("color") || undefined,
          }),
        }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to update department");
        return;
      }

      setEditingId(null);
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onDeleteDepartment(deptId: string) {
    if (!confirm("Are you sure you want to delete this department?")) return;
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deptId}`,
        { method: "DELETE" }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to delete department");
        return;
      }

      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  if (loading) return <PageLoading />;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Departments</h2>
        <Button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "Create Department"}
        </Button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* Create department form */}
      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New Department</CardTitle>
          </CardHeader>
          <form onSubmit={onCreateDepartment}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">Name</Label>
                <Input id="create-name" name="name" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-desc">Description</Label>
                <Input id="create-desc" name="description" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-color">Color</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="create-color"
                    name="color"
                    type="color"
                    defaultValue="#3B82F6"
                    className="h-10 w-14 cursor-pointer p-1"
                  />
                  <span className="text-sm text-muted-foreground">
                    Used in calendar view
                  </span>
                </div>
              </div>
              <Button type="submit">Create</Button>
            </CardContent>
          </form>
        </Card>
      )}

      {/* Department list */}
      {departments.length === 0 ? (
        <EmptyState title="No departments yet" description="Create your first department to get started." />
      ) : (
        <div className="space-y-4">
          {departments.map((dept) => (
            <Card key={dept.id}>
              {editingId === dept.id ? (
                <form onSubmit={(e) => onUpdateDepartment(e, dept.id)}>
                  <CardContent className="space-y-4 pt-6">
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input
                        name="name"
                        defaultValue={dept.name}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        name="description"
                        defaultValue={dept.description || ""}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Color</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          name="color"
                          type="color"
                          defaultValue={dept.color || "#3B82F6"}
                          className="h-10 w-14 cursor-pointer p-1"
                        />
                        <span className="text-sm text-muted-foreground">
                          Used in calendar view
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingId(null)}
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
                      <div className="flex items-center gap-3">
                        <div
                          className="h-4 w-4 rounded-full"
                          style={{ backgroundColor: dept.color || "#94A3B8" }}
                        />
                        <div>
                          <CardTitle>{dept.name}</CardTitle>
                          {dept.description && (
                            <CardDescription>{dept.description}</CardDescription>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingId(dept.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onDeleteDepartment(dept.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {dept._count.departmentMemberships} member
                      {dept._count.departmentMemberships !== 1 ? "s" : ""}
                    </p>
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