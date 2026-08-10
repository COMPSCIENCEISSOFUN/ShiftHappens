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
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { PermissionProvider } from "@/components/layout/permission-provider";
import { PlanProvider } from "@/components/layout/plan-provider";
import type { SubscriptionTier } from "@/lib/subscription-tiers";

export interface AppShellProps {
  user: { name: string | null; email: string };
  /** Undefined on the pages that exist before any organisation does. */
  orgId?: string;
  orgName?: string;
  /**
   * Every organisation the caller belongs to, for the sidebar's switcher.
   *
   * Passed only by `org/[orgId]/layout.tsx`. The org-agnostic chrome leaves it
   * out on purpose: with no current organisation there is nothing for a
   * switcher to switch away FROM, and a list with nothing marked as "you are
   * here" is a worse answer than no list.
   */
  organizations?: { id: string; name: string }[];
  role?: string;
  employmentType?: string;
  customRoleLabel?: string;
  /** The caller's effective permissions IN `orgId`, never in some other org. */
  permissions: string[];
  /**
   * The organisation's plan.
   *
   * Defaulted rather than required, because the org-agnostic pages that render
   * this chrome have no plan to report. Free is the restricted end, so a
   * missing value hides tier-gated links rather than offering them.
   */
  tier?: SubscriptionTier;
  children: React.ReactNode;
}

export function AppShell({
  user,
  orgId,
  orgName,
  organizations,
  role,
  employmentType,
  customRoleLabel,
  permissions,
  tier = "free",
  children,
}: AppShellProps) {
  return (
    /*
      The plan wraps the SIDEBAR as well as the page, which the permission
      context does not need to: the menu hides two tier-gated destinations, and
      reading that from anywhere else would be a second source for the same
      answer — the arrangement this component exists to prevent.
    */
    <PlanProvider orgId={orgId} tier={tier}>
    <div className="flex min-h-screen">
      <AppSidebar
        user={user}
        orgId={orgId}
        orgName={orgName}
        organizations={organizations}
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

      {/*
        The assistant, only where there is an organisation to ask about.

        `orgId` is undefined on the org-agnostic chrome — onboarding, and the
        profile of somebody in more than one organisation — and every question
        it can answer is about a particular organisation's data. A launcher
        there would open onto nine questions that all refuse.

        INSIDE both providers, deliberately. It reads the permission and the
        plan from the same context the sidebar and the pages read, so the
        launcher cannot appear for somebody the route will then refuse. That
        was the whole lesson of the shell reporting every organisation as Free
        while the page inside it knew better.
      */}
      {orgId && (
        <PermissionProvider permissions={permissions}>
          <AssistantPanel orgId={orgId} role={role} />
        </PermissionProvider>
      )}
    </div>
    </PlanProvider>
  );
}
