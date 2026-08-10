/**
 * Your profile, with no organisation in the address (Boundary Layer).
 *
 * Kept for the one person this is the right answer for: a signed-in user who
 * has not joined or created an organisation yet, and therefore has no
 * `/org/[orgId]` to hang the page off. `DefaultOrgShell` renders the
 * org-agnostic chrome around it, which is honest here — there genuinely is no
 * organisation to name.
 *
 * Everyone else reaches the same screen at `/org/[orgId]/profile`, and the
 * sidebar links there whenever it knows which organisation you are in. This
 * address is also what older links and bookmarks point at, so it stays.
 */
import ProfileSettings from "@/components/settings/profile-settings";

export default function ProfilePage() {
  return <ProfileSettings />;
}
