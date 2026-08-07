// @vitest-environment jsdom
/**
 * The history screen.
 *
 * Four screens in this codebase shipped tested at the service layer and broken
 * in the browser — the availability page read a response shape the endpoint had
 * stopped sending, and nothing failed. So the things pinned here are the ones a
 * service test cannot see: that the page reads the fields the route actually
 * returns, that an absent average reads as absent rather than as zero, and that
 * the shortfall in the hours total is explained on the tile rather than left as
 * a number that is quietly wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MyHistoryPage from "@/app/(app)/org/[orgId]/my-history/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

const SUMMARY = {
  shiftsInRange: 3,
  shiftsWorked: 2,
  hoursWorked: 12.5,
  shiftsMissingHours: 0,
  ratedShifts: 1,
  averageRating: 4,
  unratedWorkedShifts: 1,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "completed",
    outcome: "worked",
    hoursWorked: 8,
    clockInTime: "2026-07-01T01:00:00.000Z",
    clockOutTime: "2026-07-01T09:00:00.000Z",
    rejectionReason: null,
    rejectionNotes: null,
    withdrawalReason: null,
    withdrawalNotes: null,
    satisfactionRating: null,
    satisfactionComment: null,
    task: {
      id: "t1",
      title: "Saturday close",
      status: "completed",
      scheduledStart: "2026-07-01T01:00:00.000Z",
      scheduledEnd: "2026-07-01T09:00:00.000Z",
      department: { id: "d1", name: "Front of House", color: "#6366f1" },
    },
    ...overrides,
  };
}

/** Captures the URLs the page asks for, so the range filter can be asserted. */
let requested: string[] = [];

function mockApi(
  body: Record<string, unknown>,
  { ok = true }: { ok?: boolean } = {}
) {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      requested.push(url);
      return Promise.resolve({
        ok,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    rows: [row()],
    page: 1,
    pageSize: 20,
    total: 1,
    totalPages: 1,
    departments: [
      { id: "d1", name: "Front of House", color: "#6366f1" },
      { id: "d2", name: "Kitchen", color: "#ef4444" },
    ],
    summary: SUMMARY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawing what the route returns", () => {
  /*
   * Scoped to the row. "Worked" is also an option in the outcome filter, and an
   * unscoped query would pass on a page whose list failed to render at all.
   */
  it("lists a shift with its title and outcome", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    const title = await screen.findByText("Saturday close");
    const entry = title.closest("div.px-4") as HTMLElement;
    expect(within(entry).getByText("Worked")).toBeInTheDocument();
  });

  it("shows the hours the row carries", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    expect(await screen.findByText("8.0h")).toBeInTheDocument();
  });

  // Scoped for the same reason: the department filter lists it too.
  it("names the department", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    const title = await screen.findByText("Saturday close");
    const entry = title.closest("div.px-4") as HTMLElement;
    expect(within(entry).getByText("Front of House")).toBeInTheDocument();
  });

  /*
   * The reason each badge is there, in the row it is on. "No clock-out" with no
   * explanation is a member asking a manager a question the screen could have
   * answered.
   */
  it("explains an outcome that needs explaining", async () => {
    mockApi(
      payload({
        rows: [row({ outcome: "not_clocked_out", hoursWorked: null, clockOutTime: null })],
      })
    );
    render(<MyHistoryPage />);

    expect(await screen.findByText(/never out/i)).toBeInTheDocument();
  });

  it("shows the member their own reason for turning a shift down", async () => {
    mockApi(
      payload({
        rows: [
          row({
            outcome: "declined",
            hoursWorked: null,
            rejectionReason: "feeling_unwell",
            rejectionNotes: "Flu",
          }),
        ],
      })
    );
    render(<MyHistoryPage />);

    expect(await screen.findByText(/Flu/)).toBeInTheDocument();
  });

  // Scoped to the row. The hours TILE says "12.5h" whatever this row carries,
  // and an unscoped query would pass on a page with no rows at all.
  it("says nothing about hours on a row that has none", async () => {
    mockApi(payload({ rows: [row({ outcome: "declined", hoursWorked: null })] }));
    render(<MyHistoryPage />);

    const title = await screen.findByText("Saturday close");
    const entry = title.closest("div.px-4")!;
    expect(within(entry as HTMLElement).queryByText(/\dh$/)).not.toBeInTheDocument();
  });

  it("does say it on a row that has them", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    const title = await screen.findByText("Saturday close");
    const entry = title.closest("div.px-4")!;
    expect(within(entry as HTMLElement).getByText("8.0h")).toBeInTheDocument();
  });
});

describe("the totals", () => {
  /*
   * "41" over "44 in this period" read as a contradiction, because the detail
   * never said what 44 counted. Two numbers answering different questions have
   * to say which question each is answering.
   */
  it("says what the second number counts", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    expect(await screen.findByText("of 3 shifts in this period")).toBeInTheDocument();
  });

  // No "of 3 of 3". When every shift was worked there is no second number worth
  // printing, and the comparison invites a reader to look for a difference.
  it("does not compare when there is nothing to compare", async () => {
    mockApi(payload({ summary: { ...SUMMARY, shiftsWorked: 3, shiftsInRange: 3 } }));
    render(<MyHistoryPage />);

    expect(await screen.findByText("Every shift in this period")).toBeInTheDocument();
    expect(screen.queryByText(/of 3 shifts/)).not.toBeInTheDocument();
  });

  it("prints the hours worked", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    expect(await screen.findByText("12.5h")).toBeInTheDocument();
  });

  /*
   * An unrated history has no average. "0/5" would read as a score somebody
   * gave them, on their own page, for shifts nobody assessed.
   */
  it("shows a dash rather than zero when nothing has been rated", async () => {
    mockApi(
      payload({
        summary: { ...SUMMARY, averageRating: null, ratedShifts: 0 },
      })
    );
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    const tile = screen.getByText("Your average rating").closest("div")!;
    expect(within(tile).getByText("—")).toBeInTheDocument();
    expect(within(tile).queryByText("0/5")).not.toBeInTheDocument();
  });

  /*
   * The total being short is fine; the total being short and unexplained is
   * not. This is the difference between a page a member trusts and one they
   * quietly stop believing.
   */
  it("says how many shifts are missing from the hours", async () => {
    mockApi(payload({ summary: { ...SUMMARY, shiftsMissingHours: 2 } }));
    render(<MyHistoryPage />);

    expect(await screen.findByText(/2 shifts not counted/i)).toBeInTheDocument();
  });

  it("does not raise the shortfall when there is none", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(screen.queryByText(/not counted/i)).not.toBeInTheDocument();
  });
});

describe("rating from the record", () => {
  /*
   * Rating moved here from My Tasks, which showed the last three finished
   * shifts behind a toggle — so "34 left to rate" pointed at a screen that
   * would show three of them.
   */
  it("offers the stars on a worked shift", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(screen.getByRole("radio", { name: /1 out of 5/i })).toBeInTheDocument();
  });

  /*
   * `rate()` refuses anything not worked, so offering the control on a declined
   * shift would invite an error the service is going to produce anyway.
   */
  it("does not offer them on a shift that was declined", async () => {
    mockApi(payload({ rows: [row({ outcome: "declined", hoursWorked: null })] }));
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(screen.queryByRole("radio", { name: /1 out of 5/i })).not.toBeInTheDocument();
  });

  /*
   * A saved rating changes "your average rating" and "left to rate", both
   * computed server-side over the whole range. Updating the row in place would
   * leave the tiles disagreeing with the list directly beneath them.
   */
  it("reloads so the totals follow the new rating", async () => {
    mockApi(payload({ rows: [row({ satisfactionRating: null })] }));
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    const before = requested.length;
    await userEvent.click(screen.getByRole("radio", { name: /4 out of 5/i }));
    await userEvent.click(screen.getByRole("button", { name: /submit rating/i }));

    await waitFor(() => expect(requested.length).toBeGreaterThan(before + 1));
  });
});

describe("the range filter", () => {
  it("asks for three months on first load", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(requested[0]).toContain("from=");
  });

  /*
   * "All time" means no lower bound. Sending one anyway — today minus some
   * large number — would silently hide the oldest shifts of anybody who had
   * been there longer than the number.
   */
  it("sends no lower bound for all time", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.click(screen.getByRole("button", { name: "All time" }));

    await waitFor(() => expect(requested.length).toBeGreaterThan(1));
    expect(requested[requested.length - 1]).not.toContain("from=");
  });

  it("marks the chosen range as pressed", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.click(screen.getByRole("button", { name: "Last 30 days" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
  });
});

describe("narrowing the list", () => {
  it("asks the server for the chosen outcome", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "declined");

    await waitFor(() =>
      expect(requested[requested.length - 1]).toContain("outcome=declined")
    );
  });

  it("asks for the chosen department", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.selectOptions(screen.getByLabelText("Department"), "d2");

    await waitFor(() =>
      expect(requested[requested.length - 1]).toContain("department=d2")
    );
  });

  /*
   * One department is a label, not a filter — a control that can only ever do
   * nothing is worse than no control, because it invites a click.
   */
  it("hides the department filter when there is only one", async () => {
    mockApi(payload({ departments: [{ id: "d1", name: "Front of House", color: null }] }));
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(screen.queryByLabelText("Department")).not.toBeInTheDocument();
  });

  /*
   * Submitted, not typed. A request per keystroke would be six round trips to
   * spell "Saturday", each recomputing unpaged totals over the whole range,
   * with the answers free to arrive out of order.
   */
  it("does not search on every keystroke", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    const before = requested.length;
    await userEvent.type(screen.getByLabelText("Search shifts"), "Saturday");

    expect(requested.length).toBe(before);
  });

  it("searches when the form is submitted", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.type(screen.getByLabelText("Search shifts"), "Saturday{Enter}");

    await waitFor(() =>
      expect(requested[requested.length - 1]).toContain("search=Saturday")
    );
  });

  /*
   * Every control resets the page. Staying on page 4 of a set that now has two
   * would show an empty list under a total saying otherwise, and the reader
   * would blame the filter rather than the pager.
   */
  it("returns to the first page when a filter changes", async () => {
    mockApi(payload({ total: 45, totalPages: 3 }));
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(requested[requested.length - 1]).toContain("page=2"));

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "worked");

    await waitFor(() =>
      expect(requested[requested.length - 1]).toContain("page=1")
    );
  });

  it("offers a way back once something is filtered", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "declined");

    expect(
      await screen.findByRole("button", { name: /clear filters/i })
    ).toBeInTheDocument();
  });

  it("drops every filter when cleared", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "declined");
    await userEvent.click(await screen.findByRole("button", { name: /clear filters/i }));

    await waitFor(() => {
      const last = requested[requested.length - 1];
      expect(last).not.toContain("outcome=");
      expect(last).not.toContain("search=");
    });
  });
});

describe("when there is nothing to show", () => {
  it("says so rather than rendering an empty panel", async () => {
    mockApi(payload({ rows: [], total: 0 }));
    render(<MyHistoryPage />);

    expect(await screen.findByText(/Nothing here yet/i)).toBeInTheDocument();
  });

  /*
   * Different empty states for different reasons. "You have worked no shifts"
   * on a 30-day range is a claim about the member; "none in this period" is a
   * claim about the filter, and only one of them is true.
   */
  /*
   * A different claim from "you have worked no shifts". Telling somebody their
   * record is empty when in fact their filters are narrow reads as the system
   * having lost their history.
   */
  it("blames the filters when filters are set", async () => {
    mockApi(payload({ rows: [], total: 0 }));
    render(<MyHistoryPage />);
    await screen.findByText(/Nothing here yet/i);

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "declined");

    expect(await screen.findByText(/Nothing matches/i)).toBeInTheDocument();
  });

  it("suggests a wider range when one is set", async () => {
    mockApi(payload({ rows: [], total: 0 }));
    render(<MyHistoryPage />);

    expect(await screen.findByText(/wider range/i)).toBeInTheDocument();
  });
});

describe("when the load fails", () => {
  it("shows the route's own message", async () => {
    mockApi({ error: "Only staff and managers are rostered onto shifts" }, { ok: false });
    render(<MyHistoryPage />);

    expect(
      await screen.findByText(/Only staff and managers are rostered/i)
    ).toBeInTheDocument();
  });

  /*
   * And clears the list. Leaving the previous range's rows under a banner
   * saying the load failed shows one range's shifts beneath another range's
   * heading, with the totals agreeing with neither.
   */
  it("clears the rows it was showing", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);
    await screen.findByText("Saturday close");

    mockApi({ error: "Could not load your history" }, { ok: false });
    await userEvent.click(screen.getByRole("button", { name: "All time" }));

    await waitFor(() =>
      expect(screen.queryByText("Saturday close")).not.toBeInTheDocument()
    );
  });
});

describe("paging", () => {
  it("hides the pager when everything fits on one page", async () => {
    mockApi(payload());
    render(<MyHistoryPage />);

    await screen.findByText("Saturday close");
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
  });

  it("shows where you are when it does not", async () => {
    mockApi(payload({ total: 45, totalPages: 3 }));
    render(<MyHistoryPage />);

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("disables Previous on the first page", async () => {
    mockApi(payload({ total: 45, totalPages: 3 }));
    render(<MyHistoryPage />);

    expect(await screen.findByRole("button", { name: /Previous/ })).toBeDisabled();
  });

  it("disables Next on the last page", async () => {
    mockApi(payload({ page: 3, total: 45, totalPages: 3 }));
    render(<MyHistoryPage />);

    expect(await screen.findByRole("button", { name: /Next/ })).toBeDisabled();
  });
});
