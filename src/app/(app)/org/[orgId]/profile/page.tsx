/**
 * Your profile, reached from inside an organisation (Boundary Layer).
 *
 * The screen itself is org-agnostic — see `ProfileSettings`. This address
 * exists so the sidebar around it is not: `org/[orgId]/layout.tsx` renders the
 * chrome for the organisation in the URL, so opening your profile from inside
 * Harbour Cafe keeps Harbour Cafe's menu, its plan badge and its switcher.
 *
 * Before this existed, the Profile link went to `/settings/profile`, which is
 * outside the org subtree. The shell there had to answer "which organisation"
 * with no id to answer from — it guessed the oldest, and once that guess was
 * removed it correctly answered "none", which emptied the sidebar and left
 * Dashboard pointing back at the organisation picker. A page that navigates
 * you out of the organisation you were in is not a settings page.
 */
import ProfileSettings from "@/components/settings/profile-settings";

export default function OrgProfilePage() {
  return <ProfileSettings />;
}
