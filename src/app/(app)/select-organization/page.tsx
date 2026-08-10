/**
 * The organisation picker (Boundary Layer).
 *
 * Reached from `/dashboard` when the signed-in user belongs to more than one
 * organisation. A user in exactly one never sees it — being asked to choose
 * from a list of one is a worse experience than being sent straight in, and it
 * is the case almost every user is in.
 *
 * ## Why this page has no sidebar
 *
 * It sits under `(app)/layout.tsx`, which renders its children bare. That is
 * deliberate rather than unfinished: the sidebar is an organisation's menu —
 * its name, its plan, the permissions the caller holds INSIDE it — and this is
 * the one screen in the product where no organisation has been chosen yet.
 * Rendering a menu here would mean picking one of the options to decorate the
 * page with while asking which option the user wants, which is the same guess
 * this whole change exists to remove.
 *
 * ## Suspended organisations are listed
 *
 * Listed, marked, and still clickable. `org/[orgId]/layout.tsx` answers a
 * suspended organisation with the suspension banner, which tells the user what
 * has happened and who to contact. Hiding the organisation instead would leave
 * somebody staring at a list their colleague can see and they cannot, with
 * nothing on screen to explain it.
 *
 * BCE compliant: only imports from Control layer (services).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import {
  SUBSCRIPTION_TIERS,
  TIER_CONFIG,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

const orgService = new OrganizationService();

/** Role strings are stored plain; this is the label a person reads. */
const ROLE_LABELS: Record<string, string> = {
  company_admin: "Company admin",
  manager: "Manager",
  staff: "Staff",
};

export default async function SelectOrganizationPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const orgs = await orgService.getUserOrganizations(session.user.id);

  /*
   * Both of these are reachable by typing the URL, and both send the user
   * where they would have gone anyway. Answering here rather than rendering a
   * chooser with nothing to choose keeps `/dashboard` and this page agreeing
   * about what each org count means, instead of the rule living in one file
   * and the page assuming it.
   */
  if (orgs.length === 0) redirect("/onboarding");
  if (orgs.length === 1) redirect(`/org/${orgs[0].id}/dashboard`);

  const firstName = session.user.name?.split(" ")[0] || "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-indigo-50 via-background to-background px-4 py-12 dark:from-indigo-950/30">
      <div className="w-full max-w-md">
        {/*
          The product mark, because this page is outside the signed-in chrome
          and would otherwise be the only screen in the application with
          nothing on it that says which application it is.
        */}
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-600 to-violet-600 text-sm font-extrabold text-white shadow-sm">
            S
          </div>
          <span className="text-[15px] font-bold tracking-tight">
            Smart Task
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          You belong to {orgs.length} organisations. Choose one to open.
        </p>

        <ul className="mt-6 space-y-2.5">
          {orgs.map((org) => {
            // The membership list is filtered to this user and to active rows
            // by the repository, so there is exactly one and it is theirs.
            const role = org.memberships[0]?.role;

            // Validated rather than cast, for the same reason the two layouts
            // validate it: the column is a plain string and an unrecognised
            // value must read as the restricted end, not unlock Enterprise on
            // a typo.
            const tier: SubscriptionTier = SUBSCRIPTION_TIERS.includes(
              org.subscriptionTier as SubscriptionTier
            )
              ? (org.subscriptionTier as SubscriptionTier)
              : "free";

            const suspended = org.status !== "active";

            return (
              <li key={org.id}>
                <Link
                  href={`/org/${org.id}/dashboard`}
                  className="group flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm transition-all hover:-translate-y-px hover:border-indigo-400 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                >
                  {/*
                    The same initial-in-a-tile the sidebar shows for the current
                    organisation. Carrying it here means the thing you pressed
                    and the thing you land on are recognisably the same object,
                    which matters most for the switch you make least often.
                  */}
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[12px] bg-gradient-to-br from-indigo-600 to-violet-600 text-base font-extrabold text-white">
                    {org.name[0].toUpperCase()}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">
                      {org.name}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {ROLE_LABELS[role] ?? role ?? "Member"}
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-[11px] text-muted-foreground/50"
                      >
                        &middot;
                      </span>
                      {/*
                        The plan, said plainly. Two organisations on different
                        plans is the only place in the product where the
                        difference is visible side by side, and it is the
                        answer to "why can I do that over there and not here".
                      */}
                      <span
                        className={`rounded-full px-2 py-px text-[10px] font-semibold ${
                          tier === "free"
                            ? "bg-muted text-muted-foreground"
                            : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                        }`}
                      >
                        {TIER_CONFIG[tier].displayName}
                      </span>
                      {suspended && (
                        <span className="rounded-full bg-amber-100 px-2 py-px text-[10px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                          Suspended
                        </span>
                      )}
                    </div>
                  </div>

                  <span
                    aria-hidden="true"
                    className="shrink-0 text-sm text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-600 dark:group-hover:text-indigo-400"
                  >
                    &rarr;
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          You can switch organisations at any time from the sidebar.
        </p>
      </div>
    </div>
  );
}
