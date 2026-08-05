/**
 * The signed-in chrome: sidebar, main column, and the permission context.
 *
 * ## Why this is a component rather than a layout
 *
 * It used to live in `(app)/layout.tsx`, which sits ABOVE `org/[orgId]` in the
 * route tree and therefore never sees the org id. So it resolved everything —
 * the org name, the role badge, the suspension check, and the permission set
 * every page gates on — from `orgs[0]`, the user's arbitrarily-first
 * organisation, while the page below it read a different id from the URL.
 *
 * For anyone in one organisation those are the same value and nothing was
 * visibly wrong. For anyone in two they are not, and the consequences ran in
 * both directions: an admin of org A visiting org B's settings saw the screen
 * fully unlocked, and an admin of org B whose first org was A was told settings
 * are managed by company admins — in their own organisation.
 *
 * Pulling the chrome into a component lets the layout that actually knows the
 * org render it. `org/[orgId]/layout.tsx` passes that org; the handful of
 * org-agnostic pages pass their own default.
 *
 * ## What this is NOT
 *
 * Not a security boundary, and neither is anything it renders. It decides what
 * to OFFER. Refusing is `requirePermission` at each route, and — for the
 * question of whether you may be here at all — the membership guard in
 * `org/[orgId]/layout.tsx`.
 */
import { AppSidebar } from "@/components/layout/app-sidebar";
import { PermissionProvider } from "@/components/layout/permission-provider";

export interface AppShellProps {
  user: { name: string | null; email: string };
  /** Undefined on the pages that exist before any organisation does. */
  orgId?: string;
  orgName?: string;
  role?: string;
  employmentType?: string;
  customRoleLabel?: string;
  /** The caller's effective permissions IN `orgId`, never in some other org. */
  permissions: string[];
  children: React.ReactNode;
}

export function AppShell({
  user,
  orgId,
  orgName,
  role,
  employmentType,
  customRoleLabel,
  permissions,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen">
      <AppSidebar
        user={user}
        orgId={orgId}
        orgName={orgName}
        role={role}
        employmentType={employmentType}
        customRoleLabel={customRoleLabel}
        permissions={permissions}
      />
      <main className="flex-1 overflow-x-hidden px-4 pt-18 pb-6 md:p-6">
        {/*
          The same array reaches the sidebar and the provider, from one
          argument. That is the point of the component: the menu and the page
          it links to cannot come to disagree about who the caller is, because
          there is no second place for either to have got the answer.
        */}
        <PermissionProvider permissions={permissions}>
          {children}
        </PermissionProvider>
      </main>
    </div>
  );
}
