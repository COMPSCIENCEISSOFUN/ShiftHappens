/**
 * Chrome for a page that is not about a particular organisation.
 *
 * See `DefaultOrgShell` — these pages have no org id in their URL, so the
 * sidebar falls back to the user's oldest organisation. Everything under
 * `/org/[orgId]` has a real answer and uses its own layout instead.
 */
import { DefaultOrgShell } from "@/components/layout/default-org-shell";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <DefaultOrgShell>{children}</DefaultOrgShell>;
}
