/**
 * Your profile, reached from inside an organisation (Boundary Layer).
 *
 * The screen itself is org-agnostic — see `ProfileSettings`. This address
 * exists so the sidebar around it is not: `org/[orgId]/layout.tsx` renders the
 * chrome for the organisation in the URL, so opening your profile from inside
 * Harbour Cafe keeps Harbour Cafe's menu, its plan badge and its switcher.
 */
import ProfileSettings from "@/components/settings/profile-settings";

export default function OrgProfilePage() {
  return <ProfileSettings />;
}
