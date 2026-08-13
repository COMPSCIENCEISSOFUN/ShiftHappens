// @vitest-environment jsdom
/**
 * How the menu is grouped, and how it narrows.
 *
 * Two changes with one thing in common: neither may take a destination away.
 * A heading that moves and a rail that hides labels are both presentation, and
 * the test that matters for each is that every link a person could reach before
 * is still reachable after.
 *
 * `sidebar-permissions.test.tsx` covers WHICH links appear. This file covers
 * where they sit and what happens when the sidebar is collapsed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { PlanProvider } from "@/components/layout/plan-provider";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) })
);

function renderNav(role: string) {
  render(
    <PlanProvider tier="enterprise">
      <AppSidebar
        user={{ name: "Alex Rivera", email: "alex@example.com" }}
        orgId="org-1"
        orgName="Ocean Grill"
        role={role}
        permissions={[...(ROLE_PERMISSIONS[role] ?? [])]}
      />
    </PlanProvider>
  );
}

/** The five pages that are about the reader rather than the organisation. */
const PERSONAL_LINKS = [
  "My Tasks",
  "My Schedule",
  "My History",
  "My Availability",
  "My Certifications",
];

beforeEach(() => {
  localStorage.clear();
});

describe("the reader's own pages are grouped separately", () => {
  it("gives a manager a Personal heading", async () => {
    /*
     * A manager is the case that motivated this. They see every Overview entry
     * AND every personal one, so the section ran to nine items and the boundary
     * between "the rota" and "my rota" was a naming convention rather than
     * anything on screen.
     */
    renderNav("manager");

    expect(await screen.findByText("Personal")).toBeTruthy();
  });

  it("still offers every one of those pages", async () => {
    // The move must not cost a destination.
    renderNav("manager");

    await screen.findByText("Personal");
    for (const label of PERSONAL_LINKS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("keeps the organisation's own pages out of it", async () => {
    renderNav("manager");

    await screen.findByText("Personal");
    // Overview keeps what it was always for.
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Tasks")).toBeTruthy();
  });

  it("gives staff the heading too", async () => {
    renderNav("staff");

    expect(await screen.findByText("Personal")).toBeTruthy();
  });

  it("omits the heading for an admin, who holds no shifts", async () => {
    /*
     * An admin is excluded from rostering in three places — the eligibility
     * engine, `assignStaff` and `findSchedulableStaff` — so all five pages are
     * permanently empty for them and none is offered. A heading standing over
     * nothing would be worse than the old arrangement, not better.
     */
    renderNav("company_admin");

    await screen.findByText("Overview");
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByText("My Tasks")).toBeNull();
  });
});

describe("collapsing the sidebar", () => {
  it("offers the control", async () => {
    renderNav("manager");

    expect(await screen.findByLabelText("Collapse sidebar")).toBeTruthy();
  });

  it("narrows to a rail and back", async () => {
    renderNav("manager");

    fireEvent.click(await screen.findByLabelText("Collapse sidebar"));
    expect(screen.getByLabelText("Expand sidebar")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Expand sidebar"));
    expect(screen.getByLabelText("Collapse sidebar")).toBeTruthy();
  });

  it("keeps every link in the document", async () => {
    /*
     * The rail hides labels in CSS; it does not remove anything. Asserted
     * because the tempting implementation — rendering only the icon when
     * collapsed — takes the accessible name away with the text, and a menu
     * that empties itself for a screen reader when a sighted user narrows it
     * is a worse menu than the one we started with.
     */
    renderNav("manager");

    fireEvent.click(await screen.findByLabelText("Collapse sidebar"));

    for (const label of [...PERSONAL_LINKS, "Dashboard", "Tasks", "Members"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("remembers the choice", async () => {
    // A preference, not a mode: a menu that re-opened itself on every
    // navigation would be worse than one that never collapsed.
    renderNav("manager");

    fireEvent.click(await screen.findByLabelText("Collapse sidebar"));

    expect(localStorage.getItem("sidebar-collapsed")).toBe("1");
  });

  it("starts collapsed when that is what was stored", async () => {
    localStorage.setItem("sidebar-collapsed", "1");

    renderNav("manager");

    expect(await screen.findByLabelText("Expand sidebar")).toBeTruthy();
  });

  it("starts expanded by default", async () => {
    renderNav("manager");

    expect(await screen.findByLabelText("Collapse sidebar")).toBeTruthy();
  });
});
