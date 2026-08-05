/**
 * Auth Layout (Boundary Layer)
 *
 * Shared layout for all authentication pages (login, register,
 * verify-email, forgot-password, reset-password, accept-invitation).
 *
 * Desktop: split-screen with branded hero panel (left) + form (right).
 * Mobile: hero panel hidden, compact branded header strip at top,
 * form centered with safe padding.
 */
import Link from "next/link";
import { AuthHeroPanel } from "@/components/auth/auth-hero-panel";

/*
 * No session guard here, deliberately.
 *
 * A layout cannot reliably know which of its pages is rendering — Next 16 gives
 * it no pathname — and the pages beneath it do not want the same answer.
 * Verifying an email, resetting a password and accepting an invitation are all
 * reached from a link in a mail and are legitimately opened by someone who
 * already has a session; redirecting them would make those links dead ends. So
 * `login` and `register` carry the guard themselves, where the decision is
 * unambiguous. A guard here keyed on a header that may be absent would refuse
 * everything the moment the header changed name.
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Left: Branded hero panel (hidden on mobile) */}
      <AuthHeroPanel />

      {/* Right: Form content */}
      <div className="flex flex-1 flex-col items-center bg-background px-4 py-8 sm:px-6 sm:py-12 lg:justify-center">
        {/* Mobile: branded top strip (visible only when hero is hidden) */}
        <div className="mb-6 flex w-full max-w-md items-center justify-center rounded-xl bg-gradient-to-r from-indigo-600 to-violet-500 px-4 py-3 lg:hidden">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20 text-sm font-extrabold text-white">
              S
            </div>
            <span className="text-sm font-bold text-white">
              Smart Task Allocation
            </span>
          </div>
        </div>

        {/* Desktop: logo (hidden on mobile since branded strip replaces it) */}
        <Link
          href="/"
          className="mb-8 hidden items-center gap-2.5 lg:flex"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-sm font-extrabold text-white">
            S
          </div>
          <span className="text-lg font-bold text-foreground">
            Smart Task Allocation
          </span>
        </Link>

        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
