/**
 * Roles Management Page (Boundary Layer)
 *
 * Company admins define custom roles and the permissions attached to them.
 * System roles are shown but cannot be edited or deleted.
 *
 * ## On the visual language
 *
 * This page predates the Phase 12 overhaul: shadcn `Card` primitives where
 * every other page uses the house panel, a bare `h2` with no subtitle, no stat
 * tiles, no icons, and two hard-coded light-mode colours. It now matches
 * Departments, Members and Calendar.
 *
 * ## Two behaviour bugs fixed here
 *
 * 1. The create form and the edit form shared ONE `selectedPermissions` array,
 *    and neither closed the other. With the create form open, clicking Edit
 *    rendered both, reading and writing the same selection — ticking a box in
 *    one moved it in the other, and whichever you saved won. Opening either
 *    form now closes the other, which is the only way one shared selection can
 *    be correct.
 *
 * 2. Unticking every permission and saving was silently ignored: the update
 *    sent `permissionIds: undefined`, Prisma skipped the field, and the role
 *    kept its old permissions while the UI reported success. Creating already
 *    refused an empty selection; editing now refuses it too, for the same
 *    reason and with the same message.
 */
"use client";

import { useEffect, useState } from "react";
import { usePermissions } from "@/components/layout/permission-provider";
import { useParams } from "next/navigation";
import { KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { Panel } from "@/components/ui/panel";
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  DANGER_GHOST_BUTTON,
} from "@/components/ui/button-styles";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Permission {
  id: string;
  name: string;
  description: string;
  category: string;
  /**
   * Present only on permissions the subscription plan gates.
   *
   * Absent means "no plan question here", which is a different statement from
   * "your plan allows it" — so the two must not collapse into one boolean.
   */
  available?: boolean;
  /** The lowest plan that honours it. Named, because "Enterprise" is actionable. */
  requiredTier?: string;
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

/* ------------------------------------------------------------------ */
/*  Shared page furniture                                              */
/* ------------------------------------------------------------------ */





/**
 * The permission picker, grouped by category.
 *
 * One component for both forms. It was duplicated before — 25 lines of
 * checkbox markup written out twice — which is how the two forms came to share
 * one selection array without anybody noticing.
 */
function PermissionPicker({
  grouped,
  selected,
  onToggle,
  state,
}: {
  grouped: Record<string, Permission[]>;
  selected: string[];
  onToggle: (id: string) => void;
  /** Why the picker might be empty — see `fetchPermissions`. */
  state: "loading" | "loaded" | "empty" | "failed" | "forbidden";
}) {
  const categories = Object.keys(grouped).sort();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Permissions</Label>
        <span className="text-[11px] text-muted-foreground">
          {selected.length} selected
        </span>
      </div>

      {categories.length === 0 ? (
        /*
          Three different reasons, three different answers. The single message
          this replaced said "the permission list failed to load — reload the
          page" for all of them, which on an unseeded database is both wrong and
          unactionable: reloading cannot populate a table.
        */
        <p className="rounded-lg border border-border p-3 text-[12px] text-muted-foreground">
          {state === "loading" ? (
            "Loading permissions…"
          ) : state === "failed" ? (
            "Could not load the permission list. Reload the page to try again."
          ) : (
            <>
              The permission catalogue has not been seeded on this database.
              Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                npx prisma db seed
              </code>{" "}
              and reload. Until then a role cannot be given any permissions.
            </>
          )}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {categories.map((category) => (
            <div key={category} className="rounded-lg border border-border p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {category}
              </p>
              <div className="space-y-1">
                {grouped[category].map((perm) => {
                  /*
                    Plan-gated and unavailable. The route guard checks the plan
                    BEFORE the permission, so ticking this box opens nothing —
                    and since custom roles are Pro-and-above while the audit log
                    is Enterprise-only, it was a guaranteed no-op for every
                    organisation able to see it. Enforcement was always correct;
                    the builder just did not say so.
                  */
                  const locked = perm.available === false;
                  return (
                    <label
                      key={perm.id}
                      className={`flex items-start gap-2 text-[12px] ${
                        locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(perm.id)}
                        onChange={() => onToggle(perm.id)}
                        disabled={locked}
                        className="mt-0.5 accent-indigo-600"
                      />
                      <span>
                        {perm.description}
                        {locked && (
                          <span className="ml-1.5 inline-flex items-center rounded-[4px] bg-muted px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {perm.requiredTier ?? "upgrade"} plan
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function RolesPage() {
  const { can } = usePermissions();
  const params = useParams();
  const orgId = params.orgId as string;

  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionsState, setPermissionsState] = useState<
    "loading" | "loaded" | "empty" | "failed" | "forbidden"
  >("loading");
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchRoles() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`);
      const data = await res.json();

      // A 403 body is `{ error }`, not an array. Without this `roles.map` threw
      // and the page rendered as a blank screen instead of saying why.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load roles"
        );
        setRoles([]);
        return;
      }

      setRoles(data);
      setError(null);
    } catch {
      setError("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Load the permission catalogue.
   *
   * The outcome is recorded, not just the data. An empty picker has two very
   * different causes — the request failed, or the `Permission` table was never
   * seeded — and the page used to blame the first for both. The table is
   * populated by `npx prisma db seed`, which nothing runs automatically, so on
   * a fresh or demo-seeded database the honest answer is the second one, and
   * telling an admin to reload sends them round a loop that cannot end.
   */
  async function fetchPermissions() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/permissions`);
      const data = await res.json();
      // Same shape trap — `groupedPermissions` iterates this list.
      if (res.ok && Array.isArray(data)) {
        setPermissions(data);
        setPermissionsState(data.length > 0 ? "loaded" : "empty");
        return;
      }
      // The catalogue endpoint requires `roles:manage`, so a 403 here IS the
      // page's guard. Deriving it from the server's answer rather than from a
      // role check in the client means there is one copy of the rule, and the
      // page cannot come to disagree with the API about who may be here.
      setPermissionsState(res.status === 403 ? "forbidden" : "failed");
    } catch {
      setPermissionsState("failed");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads roles and the permission catalogue from the server on mount
    fetchRoles();
    fetchPermissions();
  }, [orgId]);

  function togglePermission(permId: string) {
    setSelectedPermissions((prev) =>
      prev.includes(permId)
        ? prev.filter((id) => id !== permId)
        : [...prev, permId]
    );
  }

  /** Permissions grouped by category, for the picker. */
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

      closeForms();
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

    // An empty selection used to be sent as `undefined`, which Prisma skips —
    // the role kept its permissions and the page reported success. Refusing it
    // matches what creating already does, and says so rather than pretending.
    if (selectedPermissions.length === 0) {
      setError("Select at least one permission");
      return;
    }

    try {
      const res = await fetch(`/api/organizations/${orgId}/roles/${roleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayLabel: formData.get("displayLabel"),
          description: formData.get("description"),
          permissionIds: selectedPermissions,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to update role");
        return;
      }

      closeForms();
      fetchRoles();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/roles/${deleteTarget.id}`,
        { method: "DELETE" }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to delete role");
        return;
      }

      setDeleteTarget(null);
      fetchRoles();
    } catch {
      setError("Something went wrong");
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Only one form is ever open, because both read the same
   * `selectedPermissions`. Opening either closes the other.
   */
  function closeForms() {
    setShowCreate(false);
    setEditingId(null);
    setSelectedPermissions([]);
  }

  function startEditing(role: Role) {
    setShowCreate(false);
    setError(null);
    setEditingId(role.id);
    setSelectedPermissions(role.rolePermissions.map((rp) => rp.permission.id));
  }

  function startCreating() {
    setEditingId(null);
    setError(null);
    setShowCreate(true);
    setSelectedPermissions([]);
  }

  if (loading) return <PageLoading />;

  /*
   * Two guards for one question, on purpose.
   *
   * The permission check is the one that decides. The 403-derived state stays
   * because it is the SERVER's answer: if the two ever disagree, the server
   * wins and the page still refuses. It is also what catches a refusal this
   * page cannot predict — a plan limit, a membership deactivated mid-session.
   *
   * The sidebar hid this page from non-admins, but the URL worked: a manager
   * who typed it got the full shell and a populated role list, because the
   * roles GET required only membership. It required only membership because
   * two other screens read the same list — so the endpoint now names all three
   * readers, and this page names the one that lets you EDIT.
   */
  if (!can("roles:manage") || permissionsState === "forbidden") {
    return (
      <div className="w-full">
        <EmptyState
          icon={Lock}
          title="Roles are managed by company admins"
          description="You can see which roles are assigned from the Members page, but only a company admin can create or change them."
        />
      </div>
    );
  }

  const grouped = groupedPermissions();
  const customRoles = roles.filter((r) => !r.isSystemRole);
  const systemRoles = roles.filter((r) => r.isSystemRole);
  const formOpen = showCreate || editingId !== null;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Roles</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Define what each kind of team member is allowed to do
          </p>
        </div>
        <button
          onClick={() => (formOpen ? closeForms() : startCreating())}
          className={formOpen ? SECONDARY_BUTTON : PRIMARY_BUTTON}
        >
          {formOpen ? (
            <>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New Role
            </>
          )}
        </button>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Custom"
          value={customRoles.length}
          detail="roles you defined"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="System"
          value={systemRoles.length}
          detail="built in, not editable"
          accentColour={STAT_ACCENT.slate}
          valueColour="text-muted-foreground"
        />
        <StatTile
          label="Permissions"
          value={permissions.length}
          detail="available to assign"
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Categories"
          value={Object.keys(grouped).length}
          detail="permission groups"
          accentColour={STAT_ACCENT.green}
        />
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      <div className="space-y-4">
        {/* ── Create form ── */}
        {showCreate && (
          <Panel title="New custom role" icon={Plus}>
            <form onSubmit={onCreateRole} className="space-y-4 p-4">
              {/*
                One name, not two.
                
                This asked for an "Internal name" as well, annotated "Used in
                code. Lowercase, no spaces." Nothing read it, the format was
                never validated, and it could not be changed afterwards — so it
                asked a manager to invent a technical identifier for a technical
                purpose that did not exist. It is derived from this field now.
              */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="create-label" className="text-xs">
                    Role name
                  </Label>
                  <Input
                    id="create-label"
                    name="displayLabel"
                    placeholder="e.g. Shift Lead"
                    required
                    maxLength={50}
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    What your team sees on members and work rules.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="create-desc" className="text-xs">
                    Description{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </Label>
                  <Input
                    id="create-desc"
                    name="description"
                    placeholder="What this role is for"
                    maxLength={500}
                    className="h-9 text-sm"
                  />
                </div>
              </div>

              <PermissionPicker
                grouped={grouped}
                selected={selectedPermissions}
                onToggle={togglePermission}
                state={permissionsState}
              />

              <div className="flex flex-wrap gap-2">
                <button type="submit" className={PRIMARY_BUTTON}>
                  Create role
                </button>
                <button
                  type="button"
                  onClick={closeForms}
                  className={SECONDARY_BUTTON}
                >
                  Cancel
                </button>
              </div>
            </form>
          </Panel>
        )}

        {/* ── Roles list ── */}
        {roles.length === 0 ? (
          // A failed load leaves the list empty too — the banner above already
          // explains that, so don't also claim there are no roles.
          error ? null : (
            <EmptyState
              title="No roles yet"
              description="Create a role to define what a group of people can do."
              icon={KeyRound}
              action={
                <button onClick={startCreating} className={PRIMARY_BUTTON}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New Role
                </button>
              }
            />
          )
        ) : (
          <div className="space-y-3">
            {roles.map((role) =>
              editingId === role.id ? (
                <Panel key={role.id} title={`Editing ${role.displayLabel}`} icon={Pencil}>
                  <form
                    onSubmit={(e) => onUpdateRole(e, role.id)}
                    className="space-y-4 p-4"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Role name</Label>
                        <Input
                          name="displayLabel"
                          defaultValue={role.displayLabel}
                          required
                          maxLength={50}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Description</Label>
                        <Input
                          name="description"
                          defaultValue={role.description || ""}
                          className="h-9 text-sm"
                        />
                      </div>
                    </div>

                    <PermissionPicker
                      grouped={grouped}
                      selected={selectedPermissions}
                      onToggle={togglePermission}
                      state={permissionsState}
                    />

                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className={PRIMARY_BUTTON}>
                        Save changes
                      </button>
                      <button
                        type="button"
                        onClick={closeForms}
                        className={SECONDARY_BUTTON}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </Panel>
              ) : (
                <div
                  key={role.id}
                  className="overflow-hidden rounded-xl border border-border bg-card"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14px] font-semibold">
                          {role.displayLabel}
                        </h3>
                        {role.isSystemRole && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                            <Lock className="h-3 w-3" aria-hidden="true" />
                            System
                          </span>
                        )}
                      </div>
                      {/*
                        The stored `name` used to be printed here as a code
                        chip. It is derived now — nobody chose it and nothing
                        reads it — so showing it put an implementation detail
                        in front of the person least able to act on it. The
                        description is what actually says what the role is for.
                      */}
                      {role.description && (
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          {role.description}
                        </p>
                      )}
                    </div>

                    {!role.isSystemRole && (
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          onClick={() => startEditing(role)}
                          className={SECONDARY_BUTTON}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(role)}
                          className={DANGER_GHOST_BUTTON}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="p-4">
                    <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      {role.rolePermissions.length} permission
                      {role.rolePermissions.length !== 1 ? "s" : ""}
                    </p>
                    {role.rolePermissions.length === 0 ? (
                      /*
                        This used to read "Anyone holding it can sign in and see
                        nothing else", which was written when permissions were
                        not enforced at all and was wrong in the other
                        direction: the holder kept everything their system role
                        gave them. Now that a custom role REPLACES the system
                        role's bundle, an empty one really does grant nothing —
                        so the warning is finally true, and worth stating
                        plainly because it is almost certainly a mistake.
                      */
                      <p className="text-[12px] text-amber-700 dark:text-amber-400">
                        This role grants nothing. Anyone holding it keeps their
                        sign-in and nothing else — not even the task list their
                        system role would normally give them.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {role.rolePermissions.map((rp) => (
                          <span
                            key={rp.permission.id}
                            title={rp.permission.description}
                            className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {rp.permission.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.displayLabel}"?`}
        description="Anyone currently holding this role loses the permissions it grants. This cannot be undone."
        confirmLabel="Delete role"
        variant="destructive"
        loading={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
