// @vitest-environment jsdom
/**
 * One route, two screens — and the bug that meant neither of them rendered.
 *
 * The endpoint began returning `{ schedule, employmentType, needsApproval }`
 * when the page needed to know which kind of member it was drawing for. The
 * page went on testing `Array.isArray(data)`, so every load failed with
 * "Failed to load schedule" and `contracted` never left its initial `false` —
 * the casual screen, over an error banner, for everybody.
 *
 * The other thing pinned here is the invented week. Initial state used to be
 * Monday–Friday 09:00–17:00, replaced only if the server sent rows. Harmless
 * while it was an editable starting point; read-only it became a contract
 * nobody had agreed, shown as fact to somebody who cannot change it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AvailabilityPage from "@/app/(app)/org/[orgId]/availability/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

const MON_WED = [
  { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true },
  { dayOfWeek: 3, startTime: "09:00", endTime: "17:00", isAvailable: true },
];

function mockApi({
  schedule = MON_WED,
  needsApproval = false,
  overrides = [] as unknown[],
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/overrides")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(overrides),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ schedule, needsApproval, employmentType: null }),
      } as Response);
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the endpoint's response", () => {
  it("loads without an error banner", async () => {
    mockApi({});
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("My Availability")).toBeInTheDocument();
    });
    expect(screen.queryByText("Failed to load schedule")).toBeNull();
  });

  it("draws the contracted screen when the server says so", async () => {
    mockApi({ needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("My Working Days")).toBeInTheDocument();
    });
  });
});

describe("a contracted member", () => {
  it("cannot edit the pattern", async () => {
    mockApi({ needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("Set by your organisation.", { exact: false })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Save schedule/ })).toBeNull();
    expect(screen.queryByLabelText("Monday start time")).toBeNull();
  });

  it("still sees what the days are", async () => {
    mockApi({ needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      // Monday and Wednesday both, so the window is not unique on the page.
      expect(screen.getAllByText("09:00 – 17:00").length).toBeGreaterThan(0);
    });
  });

  /*
   * The lie that made this rework necessary. Nobody has set a pattern, so the
   * page must say that rather than showing a plausible Monday-to-Friday week.
   */
  it("says nothing is set rather than showing an invented week", async () => {
    mockApi({ schedule: [], needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("No working days set yet")).toBeInTheDocument();
    });
    expect(screen.getByText(/rostered at any time/)).toBeInTheDocument();
  });

  it("shows a dash rather than a fabricated 40h", async () => {
    mockApi({ schedule: [], needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("Contracted hours")).toBeInTheDocument();
    });
    expect(screen.queryByText("40h")).toBeNull();
  });

  // Asking to work a day is a change to the contract, not an exception to it.
  it("is offered no direction to choose", async () => {
    mockApi({ needsApproval: true });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("Leave requests")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Available?")).toBeNull();
  });

  /*
   * Leave above the pattern. The pattern is a fact they read once; asking for
   * time off is what they opened the page to do.
   */
  it("sees leave before the contract", async () => {
    mockApi({ needsApproval: true });
    // Scoped to THIS render. Testing Library's auto-cleanup is not active here,
    // so document.body carries every earlier render in the file and the
    // comparison would be across all of them.
    const { container } = render(<AvailabilityPage />);

    await waitFor(() => {
      expect(container.innerHTML).toContain("Leave requests");
    });
    // Panel descriptions rather than titles, for the reason given below on the
    // casual ordering test.
    expect(container.innerHTML.indexOf("Ask for a day off")).toBeLessThan(
      container.innerHTML.indexOf("Set by your organisation")
    );
  });

  it("counts only unanswered requests as pending", async () => {
    mockApi({
      needsApproval: true,
      overrides: [
        { id: "1", date: "2026-09-01", isAvailable: false, reason: null, status: "pending" },
        { id: "2", date: "2026-09-02", isAvailable: false, reason: null, status: "approved" },
        { id: "3", date: "2026-09-03", isAvailable: false, reason: null, status: "rejected" },
      ],
    });
    const { container } = render(<AvailabilityPage />);

    await waitFor(() => {
      expect(container.innerHTML).toContain("Leave pending");
    });
    // One of the three is unanswered; the settled two are listed but not
    // counted, because "3 requests" reads as three things needing attention.
    const tile = container.querySelector('[class*="amber"]');
    expect(tile?.textContent).toContain("1");
  });
});

describe("a casual member", () => {
  it("keeps the editor and the save button", async () => {
    mockApi({});
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByText("Weekly schedule")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Save schedule/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Monday start time")).toBeInTheDocument();
  });

  // Theirs is an offer, so widening and narrowing are equally theirs to do.
  it("keeps both directions", async () => {
    mockApi({});
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Available?")).toBeInTheDocument();
    });
  });

  it("sees the pattern before the exceptions", async () => {
    mockApi({});
    const { container } = render(<AvailabilityPage />);

    await waitFor(() => {
      expect(container.innerHTML).toContain("Weekly schedule");
    });
    /*
     * Compared on the panels' own descriptions, not their titles: "Date
     * overrides" is also a STAT TILE label, and the tiles sit above both
     * panels — so matching on the title compared a tile against a panel and
     * measured nothing.
     */
    expect(container.innerHTML.indexOf("Your regular pattern")).toBeLessThan(
      container.innerHTML.indexOf("One-off exceptions")
    );
  });

  /*
   * A blank week is still a reasonable STARTING POINT for somebody who is about
   * to edit it — the objection was only ever to presenting one as fact to
   * somebody who cannot.
   */
  it("gets an editable week even with nothing saved", async () => {
    mockApi({ schedule: [] });
    render(<AvailabilityPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Monday start time")).toBeInTheDocument();
    });
  });
});
