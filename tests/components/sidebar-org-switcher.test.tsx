// @vitest-environment jsdom
/**
 * The sidebar knows which organisation it is in, and offers to leave it.
 *
 * Two separate claims, both of which used to be false in the same way.
 *
 * **Which organisation it is in.** Every entry in this menu is built from
 * `orgId` except the two that were not: Dashboard pointed at `/dashboard`,
 * which resolved to the user's OLDEST organisation, and Profile pointed at
 * `/settings/profile`, which is outside the org subtree entirely. So the two
 * most-pressed links in the product were the two that could take a member of
 * Ocean Grill and Harbour Cafe out of the one they were standing in.
 *
 * **Offering to leave it.** There was no switcher at all, and no picker either
 * — the organisation was chosen for you once, by row order.
 *
 * The disclosure is asserted by its accessible name rather than by its
 * markup, because the thing under test is whether somebody can find and
 * operate it, and a caret glyph is not that.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { PlanProvider } from "@/components/layout/plan-provider";

vi.mock("next/navigation", () => ({ usePathname: () => "/org/org-1/dashboard" }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));

vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) })
);

const BOTH = [
  { id: "org-1", name: "Ocean Grill" },
  { id: "org-2", name: "Harbour Cafe" },
];

/**
 * `null` means "no organisation", NOT `undefined`.
 *
 * This took `orgId: string | undefined = "org-1"` and passed `undefined` for
 * the org-less cases — which is the one value a default parameter swallows.
 * Both absence tests were therefore rendering the org-1 chrome and asserting
 * it behaved as if there were no organisation, and both failed for a reason
 * that had nothing to do with the sidebar.
 *
 * Worth keeping the note rather than just fixing it: a helper that cannot
 * construct the state under test is a whole file of assertions about a state
 * that never occurred. These two failed loudly. A default that happened to
 * agree with the expected answer would not have.
 */
function renderNav(
  organizations?: { id: string; name: string }[],
  orgId: string | null = "org-1"
) {
  render(
    <PlanProvider tier="enterprise">
      <AppSidebar
        user={{ name: "Alex Rivera", email: "alex@example.com" }}
        orgId={orgId ?? undefined}
        orgName={orgId ? "Ocean Grill" : undefined}
        organizations={organizations}
        role="company_admin"
        permissions={["reports:view"]}
      />
    </PlanProvider>
  );
}

/** The switcher, by the name a screen reader would announce. */
function switcher() {
  return screen.queryByRole("button", { name: /switch organisation/i });
}

describe("the links that used to leave the organisation", () => {
  it("points Dashboard at THIS organisation", () => {
    renderNav(BOTH);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/org/org-1/dashboard"
    );
  });

  it("points Profile at THIS organisation", () => {
    renderNav(BOTH);
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/org/org-1/profile"
    );
  });

  /*
   * The org-less case, which is the reason both bare addresses still exist. A
   * user who has not joined an organisation has no `/org/[orgId]` to hang
   * either page off, and sending them to `/org/undefined/profile` would be a
   * 404 dressed as a menu item.
   */
  it("falls back to the bare addresses when there is no organisation", () => {
    renderNav(undefined, null);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/settings/profile"
    );
  });
});

describe("the switcher", () => {
  /*
   * A disclosure that opens onto a list of one advertises a choice, costs a
   * click to discover there isn't one, and teaches people to stop pressing it.
   * Almost every user is in exactly one organisation, so this is the case that
   * must stay quiet.
   */
  it("is absent for somebody in one organisation", () => {
    renderNav([{ id: "org-1", name: "Ocean Grill" }]);
    expect(switcher()).toBeNull();
    expect(screen.getByText("Ocean Grill")).toBeInTheDocument();
  });

  it("is absent when the shell passed no list at all", () => {
    renderNav(undefined);
    expect(switcher()).toBeNull();
  });

  /*
   * And absent without a current organisation, even holding a list. The
   * org-agnostic chrome has nothing to mark as "you are here", so the menu
   * would be a set of destinations with no origin.
   */
  it("is absent on the org-agnostic chrome", () => {
    renderNav(BOTH, null);
    expect(switcher()).toBeNull();
  });

  it("appears for somebody in two", () => {
    renderNav(BOTH);
    expect(switcher()).toBeInTheDocument();
  });

  it("stays shut until it is pressed", () => {
    renderNav(BOTH);
    expect(screen.queryByRole("link", { name: "Harbour Cafe" })).toBeNull();
  });

  it("offers the other organisation, and marks the current one", async () => {
    renderNav(BOTH);
    await userEvent.click(switcher()!);

    expect(screen.getByRole("link", { name: "Harbour Cafe" })).toHaveAttribute(
      "href",
      "/org/org-2/dashboard"
    );
    expect(screen.getByText("current")).toBeInTheDocument();
  });

  /*
   * The current organisation is listed but is NOT a link.
   *
   * Two reasons, and the second is the one worth a test: a link to where you
   * already are produces a navigation that appears to do nothing, and in a
   * menu whose whole purpose is "take me somewhere else" that reads as the
   * control being broken.
   */
  it("does not offer the current organisation as a destination", async () => {
    renderNav(BOTH);
    await userEvent.click(switcher()!);

    const links = screen.getAllByRole("link");
    expect(
      links.some((a) => a.getAttribute("href") === "/org/org-1/dashboard" && a.textContent === "Ocean Grill")
    ).toBe(false);
  });
});
