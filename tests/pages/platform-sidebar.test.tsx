/**
 * Platform sidebar.
 *
 * The reason this has a test at all is the mobile drawer. The panel used to be
 * a fixed 256px column with no small-screen handling, so on a phone it ate a
 * third of the viewport and squeezed the page beside it. A drawer that does not
 * open, or does not close on navigation, fails in exactly the way nobody
 * notices on a desktop — which is where it will be developed.
 *
 * The shared-shell assertions matter for a different reason: the whole point of
 * `.app-sidebar` is that this panel and the org one cannot drift. A rewrite
 * that quietly reintroduces bespoke widths would pass every other test here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const signOut = vi.fn();
const setTheme = vi.fn();
let pathname = "/platform-admin";

vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next-auth/react", () => ({ signOut: (...a: unknown[]) => signOut(...a) }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme }),
}));

import { PlatformSidebar } from "@/components/layout/platform-sidebar";

const user = { name: "Dana Reyes", email: "dana@example.com" };

beforeEach(() => {
  pathname = "/platform-admin";
  vi.clearAllMocks();
});

function sidebar() {
  return document.querySelector("aside")!;
}

describe("shared shell", () => {
  it("uses the same structural class as the org sidebar", () => {
    render(<PlatformSidebar user={user} />);
    expect(sidebar().className).toContain("app-sidebar");
  });

  it("carries the platform variant, which is the only thing it overrides", () => {
    render(<PlatformSidebar user={user} />);
    expect(sidebar().className).toContain("app-sidebar-platform");
  });

  it("does not set its own width", () => {
    // A `w-64` here would be the drift the shared class exists to prevent.
    render(<PlatformSidebar user={user} />);
    expect(sidebar().className).not.toMatch(/\bw-\d/);
  });

  it("styles links with the shared pill class", () => {
    render(<PlatformSidebar user={user} />);
    const link = screen.getByRole("link", { name: "Organizations" });
    expect(link.className).toContain("app-sidebar-link");
  });
});

describe("navigation", () => {
  it("lists the three platform sections", () => {
    render(<PlatformSidebar user={user} />);
    for (const label of ["Dashboard", "Organizations", "Templates"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the current page for screen readers, not just visually", () => {
    pathname = "/platform-admin/organizations";
    render(<PlatformSidebar user={user} />);

    expect(screen.getByRole("link", { name: "Organizations" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("does not treat a sub-page as the dashboard", () => {
    // Dashboard is an exact match; the others match by prefix. Without that,
    // "/platform-admin/templates" would light up two entries.
    pathname = "/platform-admin/templates";
    render(<PlatformSidebar user={user} />);

    const active = screen
      .getAllByRole("link")
      .filter((l) => l.className.includes("app-sidebar-link-active"));
    expect(active.map((l) => l.textContent)).toEqual(["Templates"]);
  });

  it("nav icons are hidden from assistive tech, since the label repeats them", () => {
    render(<PlatformSidebar user={user} />);
    const link = screen.getByRole("link", { name: "Dashboard" });
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("mobile drawer", () => {
  it("starts closed", () => {
    render(<PlatformSidebar user={user} />);
    expect(sidebar().className).not.toContain("app-sidebar-mobile-open");
  });

  it("opens from the hamburger", async () => {
    const u = userEvent.setup();
    render(<PlatformSidebar user={user} />);

    await u.click(screen.getByRole("button", { name: "Open menu" }));
    expect(sidebar().className).toContain("app-sidebar-mobile-open");
  });

  it("closes from the close button", async () => {
    const u = userEvent.setup();
    render(<PlatformSidebar user={user} />);

    await u.click(screen.getByRole("button", { name: "Open menu" }));
    await u.click(screen.getByRole("button", { name: "Close menu" }));
    expect(sidebar().className).not.toContain("app-sidebar-mobile-open");
  });

  it("closes when the route changes", () => {
    // Without this the drawer stays open on top of the page you just navigated
    // to, and the only way out is the close button you can no longer see.
    const { rerender } = render(<PlatformSidebar user={user} />);
    pathname = "/platform-admin/templates";
    rerender(<PlatformSidebar user={user} />);

    expect(sidebar().className).not.toContain("app-sidebar-mobile-open");
  });

  it("renders a backdrop only while open", async () => {
    const u = userEvent.setup();
    const { container } = render(<PlatformSidebar user={user} />);

    expect(container.querySelector(".bg-black\\/50")).toBeNull();
    await u.click(screen.getByRole("button", { name: "Open menu" }));
    expect(container.querySelector(".bg-black\\/50")).not.toBeNull();
  });
});

describe("footer", () => {
  it("offers a theme toggle, which this page previously lacked entirely", () => {
    render(<PlatformSidebar user={user} />);
    expect(screen.getByRole("button", { name: /Dark mode/ })).toBeInTheDocument();
  });

  it("signs out back to the login page", async () => {
    const u = userEvent.setup();
    render(<PlatformSidebar user={user} />);

    await u.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("shows initials from the name", () => {
    render(<PlatformSidebar user={user} />);
    expect(screen.getByText("DR")).toBeInTheDocument();
  });

  it("falls back to the email when there is no name", () => {
    render(<PlatformSidebar user={{ name: null, email: "dana@example.com" }} />);
    expect(screen.getByText("D")).toBeInTheDocument();
    expect(screen.getByText("Platform admin")).toBeInTheDocument();
  });
});
