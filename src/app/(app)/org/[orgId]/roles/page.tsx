/**
 * Roles Management Page (Boundary Layer)
 *
 * Company admins define custom roles and the permissions attached to them.
 *
 */
"use client";

import { useEffect, useState } from "react";
import { usePermissions } from "@/components/layout/permission-provider";
import { useParams } from "next/navigation";
import {
  Award,
  Building,
  Building2,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  CreditCard,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Scale,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PlanLocked, LimitNotice } from "@/components/ui/plan-gate";
import { usePlan } from "@/components/layout/plan-provider";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { Panel } from "@/components/ui/panel";
import { apiErrorMessage } from "@/lib/api-error";
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
  /** How many members hold it. Absent on responses predating the field. */
  memberCount?: number;
  /**
   * Whether the reader is one of them.
   *
   * Answered by the server, because this page knows only the caller's
   * permission NAMES — matching the role's label against the chip in the
   * sidebar would be inferring identity from a string two roles could share.
   */
  heldByCaller?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Shared page furniture                                              */
/* ------------------------------------------------------------------ */

/**
 * What the delete confirmation actually says.
 *
 * It read "Anyone currently holding this role loses the permissions it grants"
 * — true of every custom role ever created, and so no help at all in deciding
 * whether to press the button. Two facts change that answer, and neither was
 * on screen.
 *
 * The first is reach: three people is a different decision from nobody.
 *
 * The second is the one this was written for. `Membership.customRoleId` is
 * `onDelete: SetNull`, so deleting a role you HOLD strips it from you like
 * anyone else — and if `roles:manage` came to you through that role, you have
 * just deleted your own way back to this page. Recoverable, but only by a
 * company admin, and the old wording gave no hint it was about to happen.
 */
export function deletionWarning(role: Role | null): string {
  if (!role) return "";

  const count = role.memberCount ?? 0;
  const reach =
    count === 0
      ? "Nobody currently holds this role."
      : count === 1
        ? "1 member holds this role and loses the permissions it grants."
        : `${count} members hold this role and lose the permissions it grants.`;

  const self = role.heldByCaller
    ? " You are one of them — if this role is what lets you manage roles, you will not be able to undo this yourself."
    : "";

  return `${reach}${self} This cannot be undone.`;
}



/**
 * How each permission category is shown: a readable name and an icon.
 *
 * The category came straight off the catalogue row, so the picker printed
 * `work_rules` and `organization` at an admin — a database value used as a
 * label, which is the same defect as the permission chips printing
 * `tasks:assign`. Fourteen unlabelled boxes of similar-looking text is also
 * simply hard to scan; the icon is what makes a category findable at a glance,
 * which is the whole reason the rest of the application uses one per section.
 *
 * Here rather than beside the catalogue in `lib/permissions.ts`, even though
 * that is where `AUDIT_ENTITY_LABELS` lives, because these carry lucide
 * components. That file is imported by services, and putting an icon set behind
 * it would pull React components into every server bundle that asks what a
 * permission means.
 *
 * A category with no entry falls back to its raw name rather than disappearing:
 * adding a permission in a new category should look unstyled, not invisible.
 */
const CATEGORY_PRESENTATION: Record<
  string,
  { label: string; icon: LucideIcon }
> = {
  departments: { label: "Departments", icon: Building2 },
  members: { label: "Members", icon: Users },
  tasks: { label: "Tasks & shifts", icon: ClipboardList },
  eligibility: { label: "Eligibility", icon: UserCheck },
  allocation: { label: "Allocation", icon: Sparkles },
  reports: { label: "Reports", icon: ChartColumn },
  calendar: { label: "Calendar", icon: CalendarDays },
  settings: { label: "Settings", icon: Settings },
  roles: { label: "Roles", icon: Shield },
  organization: { label: "Organisation", icon: Building },
  audit: { label: "Audit log", icon: ScrollText },
  work_rules: { label: "Work rules", icon: Scale },
  certifications: { label: "Certifications", icon: Award },
  billing: { label: "Billing", icon: CreditCard },
};

function categoryPresentation(category: string) {
  return (
    CATEGORY_PRESENTATION[category] ?? { label: category, icon: KeyRound }
  );
}

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

  /*
   * The author's own permissions, so the picker can stop offering what the
   * server will refuse.
   *
   * The refusal itself lives in `RoleService.assertMayGrantPermissions` and has
   * to, because the endpoint accepts any list of ids from anyone holding
   * `roles:manage` — a disabled checkbox stops a mistake, not a request. This
   * is the sign next to the fence.
   *
   * A company admin holds the whole catalogue, so nothing greys out for one.
   * This appears only for somebody who was DELEGATED `roles:manage` through a
   * custom role, which is precisely the case the server check was written for.
   */
  const { can } = usePermissions();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Permissions</Label>
        <span className="text-xs text-muted-foreground">
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
        <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          {state === "loading" ? (
            "Loading permissions…"
          ) : state === "failed" ? (
            "Could not load the permission list. Reload the page to try again."
          ) : (
            <>
              The permission catalogue has not been seeded on this database.
              Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                npx prisma db seed
              </code>{" "}
              and reload. Until then a role cannot be given any permissions.
            </>
          )}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {categories.map((category) => {
            const { icon: CategoryIcon, label } = categoryPresentation(category);
            const chosen = grouped[category].filter((p) =>
              selected.includes(p.id)
            ).length;

            return (
            <div key={category} className="rounded-lg border border-border p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <CategoryIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {label}
                </p>
                {/*
                  Per-category count. The single "N selected" above the picker
                  answers "how big is this role"; composing one is a question
                  per area — "have I given them everything they need for
                  tasks?" — and with fourteen categories on screen that is not
                  answerable by counting ticks.
                */}
                {chosen > 0 && (
                  <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                    {chosen}
                  </span>
                )}
              </div>
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
                  const planLocked = perm.available === false;
                  const isSelected = selected.includes(perm.id);
                  /*
                    Not held by the author, and not already in the role.

                    The second half is what keeps this honest. The server checks
                    only what is being ADDED — removing a permission grants
                    nobody anything — so a box that is already ticked stays
                    clickable even when the author does not hold it. Disabling
                    it would refuse an edit the server would have accepted,
                    which is a UI lying in the safe direction rather than being
                    right. It also means an admin-built role stays reducible by
                    whoever inherits it.
                  */
                  const notMine = !isSelected && !can(perm.name);
                  const locked = planLocked || notMine;
                  return (
                    <label
                      key={perm.id}
                      className={`flex items-start gap-2 text-xs ${
                        locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
                      title={
                        notMine
                          ? "You do not hold this permission, so you cannot put it in a role."
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggle(perm.id)}
                        disabled={locked}
                        className="mt-0.5 accent-indigo-600"
                      />
                      <span>
                        {perm.description}
                        {/*
                          The plan badge wins when both apply. "Enterprise plan"
                          is the one the reader can do something about, and
                          stacking two greyed badges on one line says less than
                          either alone.
                        */}
                        {planLocked ? (
                          <span className="ml-1.5 inline-flex items-center rounded-[4px] bg-muted px-1.5 py-0.5 align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {perm.requiredTier ?? "upgrade"} plan
                          </span>
                        ) : notMine ? (
                          <span className="ml-1.5 inline-flex items-center rounded-[4px] bg-muted px-1.5 py-0.5 align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            not yours to grant
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            );
          })}
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
  const plan = usePlan();
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
        setError(apiErrorMessage(result, "Failed to create role"));
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
        setError(apiErrorMessage(result, "Failed to update role"));
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
        setError(apiErrorMessage(result, "Failed to delete role"));
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

  /*
   * The plan, after the permission and before anything else.
   *
   * Same order the route guard uses, and for the same reason: a member without
   * `roles:manage` should be told they lack the permission, not offered an
   * upgrade they cannot buy and would not benefit from.
   *
   * This page previously showed the full builder on a Free organisation —
   * fourteen categories of checkboxes, a working New Role button — and refused
   * on save. The refusal was correct; offering the work first was not.
   */
  if (!plan.has("custom_roles")) {
    return (
      <div className="w-full">
        <PlanLocked
          feature="custom_roles"
          title="Custom roles"
          description="They let you grant a precise set of permissions to one person without changing their role."
          orgId={orgId}
        />
      </div>
    );
  }

  const grouped = groupedPermissions();
  /*
   * `isSystemRole` rows do not exist.
   *
   * The column is on `Role`, three services guard against editing, deleting or
   * assigning such a row, and this page carried a "System" stat tile and a
   * lock badge for them — but a grep of the whole repository finds nothing that
   * ever writes `isSystemRole: true` except tests. No seed, no service, no
   * migration. So the tile always read 0 and the badge could never render,
   * while the page's own header claimed system roles were "shown but cannot be
   * edited".
   *
   * The UI is gone. The SERVICE guards stay: they are three lines, they are
   * exercised by `role.service.test.ts` and `user-management.service.test.ts`
   * against rows those suites create deliberately, and they are what would hold
   * if the system roles ever were seeded — which is a real option, discussed
   * and deferred rather than ruled out. Tested defence in depth is worth
   * keeping; an unreachable screen is not.
   *
   * The filter itself stays too, so a seeded system role would be excluded from
   * the editable list rather than appearing with an Edit button.
   */
  const customRoles = roles.filter((r) => !r.isSystemRole);
  const formOpen = showCreate || editingId !== null;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Roles</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Define what each kind of team member is allowed to do
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <LimitNotice resource="custom_roles" noun="roles" />
          {/*
            Disabled at the cap rather than refused on save. The plan limit was
            enforced only by `enforceResourceLimit` in the service, so the
            eleventh role on a Pro organisation could be named, described and
            composed before anything mentioned there was a maximum.

            Cancel is never disabled: closing a form you already opened is not
            creating anything.
          */}
          <button
            onClick={() => (formOpen ? closeForms() : startCreating())}
            disabled={!formOpen && plan.atLimit("custom_roles")}
            className={`${formOpen ? SECONDARY_BUTTON : PRIMARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
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
      </div>

      {/*
        ── Stat tiles ──

        Three, not four. The "System" tile counted rows nothing creates, so it
        read 0 on every organisation that has ever existed — a quarter of the
        summary devoted to a constant.

        The detail line on Custom now says what a role DOES rather than where it
        came from, because "roles you defined" was the only thing on this screen
        distinguishing them from the system ones that were never there.
      */}
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
        <StatTile
          label="Custom roles"
          value={customRoles.length}
          detail="each adds to a system role"
          accentColour={STAT_ACCENT.indigo}
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
                  <p className="text-xs text-muted-foreground">
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
        {customRoles.length === 0 ? (
          // A failed load leaves the list empty too — the banner above already
          // explains that, so don't also claim there are no roles.
          error ? null : (
            <EmptyState
              title="No roles yet"
              description="Create a role to define what a group of people can do."
              icon={KeyRound}
              action={
                <button
                  onClick={startCreating}
                  disabled={plan.atLimit("custom_roles")}
                  className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New Role
                </button>
              }
            />
          )
        ) : (
          <div className="space-y-3">
            {customRoles.map((role) =>
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
                        <h3 className="text-sm font-semibold">
                          {role.displayLabel}
                        </h3>
                      </div>
                      {/*
                        The stored `name` used to be printed here as a code
                        chip. It is derived now — nobody chose it and nothing
                        reads it — so showing it put an implementation detail
                        in front of the person least able to act on it. The
                        description is what actually says what the role is for.
                      */}
                      {role.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {role.description}
                        </p>
                      )}
                    </div>

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
                  </div>

                  <div className="p-4">
                    <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        {role.rolePermissions.length} permission
                        {role.rolePermissions.length !== 1 ? "s" : ""}
                      </span>
                      {/*
                        Reach, beside size. A role with fourteen permissions and
                        nobody wearing it is a draft; the same role on nine
                        people is the thing to be careful with, and the card
                        could not tell them apart.
                      */}
                      <span className="flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5" aria-hidden="true" />
                        {role.memberCount ?? 0} member
                        {(role.memberCount ?? 0) !== 1 ? "s" : ""}
                        {role.heldByCaller && (
                          <span className="rounded-[4px] bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                            including you
                          </span>
                        )}
                      </span>
                    </p>
                    {role.rolePermissions.length === 0 ? (
                      /*
                        Third wording, and the first two were each true when
                        written. Before permissions were enforced at all this
                        said the holder could "sign in and see nothing else",
                        which was wrong — they kept their system role's access.
                        While a custom role REPLACED that bundle it really did
                        grant nothing, and the warning said so. Roles add now,
                        so an empty one is simply inert.

                        Kept as a warning rather than deleted: an empty role is
                        still almost certainly a mistake, and "it does nothing"
                        is the useful thing to say about it.
                      */
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        This role has no effect. Anyone holding it keeps exactly
                        the permissions of their system role and gains nothing.
                      </p>
                    ) : (
                      <>
                        {/*
                          What the role DOES, which the chip list alone never
                          said. The two sentences are the same rule read from
                          each end, and both are worth printing because an admin
                          composing a role is thinking about one person at a
                          time: `STAFF_PERMISSIONS` is empty, so on a staff
                          member this list is the whole of their access, while a
                          manager keeps their bundle underneath it.

                          This is also where the old model was invisible. A
                          reader of this card could not tell that handing the
                          role to a manager took twelve permissions away.
                        */}
                        <p className="mb-2 text-xs text-muted-foreground">
                          Added to whatever the member&rsquo;s system role
                          already allows. On a staff member, who holds nothing by
                          default, this list is everything they can do; a manager
                          keeps the manager permissions as well.
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {role.rolePermissions.map((rp) => (
                            /*
                              The description, not the name. `tasks:assign` is
                              an identifier for the catalogue and this screen is
                              read by whoever runs the venue — the picker above
                              has always shown descriptions, so the two halves
                              of one page named the same thing two ways. The
                              slug moves to the tooltip, where somebody
                              debugging can still reach it.
                            */
                            <span
                              key={rp.permission.id}
                              title={rp.permission.name}
                              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {rp.permission.description}
                            </span>
                          ))}
                        </div>
                      </>
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
        description={deletionWarning(deleteTarget)}
        confirmLabel="Delete role"
        variant="destructive"
        loading={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
