// @vitest-environment jsdom
/**
 * The screen for the endpoint that had none.
 *
 * `PUT .../contracted-days` shipped tested and unreachable: full-time staff had
 * just lost the ability to set their own pattern, and the only way to set
 * anybody's was curl. This is the fourth built-and-uncalled pair in this
 * codebase and the one that mattered most, because the feature it completes was
 * otherwise a lock with nobody holding the key.
 *
 * Two modes, off EMPLOYMENT TYPE rather than role. A full-timer is contracted,
 * so their days are the employer's to set. A casual's availability is an offer
 * they make, so it is read-only with the nudge that already existed — an edit
 * an admin makes here is one the casual could undo the same evening, and the
 * screen should not imply otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContractedDaysEditor } from "@/components/members/contracted-days-editor";

const MON_WED = [
  { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true },
  { dayOfWeek: 3, startTime: "09:00", endTime: "17:00", isAvailable: true },
];

function mockFetch(get: unknown, ok = true) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve({
        ok,
        json: () => Promise.resolve(ok ? [] : { error: "Could not save" }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(get),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderEditor(props: Partial<Parameters<typeof ContractedDaysEditor>[0]> = {}) {
  return render(
    <ContractedDaysEditor
      orgId="org1"
      userId="u1"
      employmentType="full_time"
      memberName="Sam"
      {...props}
    />
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a contracted member", () => {
  it("shows the days that are actually stored", async () => {
    mockFetch(MON_WED);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByLabelText("Mon start time")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Mon start time")).toHaveValue("09:00");
  });

  /*
   * The days NOT returned are unticked rather than absent. A week that only
   * listed Monday and Wednesday would give an admin no way to add Friday.
   */
  it("shows every day, so one can be added", async () => {
    mockFetch(MON_WED);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByLabelText("Fri start time")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Fri start time")).toBeDisabled();
  });

  it("sends the whole week in one request", async () => {
    const fetchMock = mockFetch(MON_WED);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Save working days/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Save working days/ }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeTruthy();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.schedule).toHaveLength(7);
    });
  });

  it("reports a refusal rather than claiming it saved", async () => {
    mockFetch(MON_WED, false);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Save working days/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Save working days/ }));

    await waitFor(() => {
      expect(screen.getByText("Could not save")).toBeInTheDocument();
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  /*
   * Somebody with no pattern is rosterable at ANY time. Drawing a plausible
   * week here would make an admin think they were looking at one that had been
   * set — the same lie the member's own page used to tell.
   */
  it("says nothing is set rather than inventing a week", async () => {
    mockFetch([]);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByText(/No days set/)).toBeInTheDocument();
    });
    expect(screen.getByText(/rostered at any time/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Mon start time")).toBeNull();
  });

  it("offers to start one, opened rather than narrowed", async () => {
    mockFetch([]);
    renderEditor();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Set working days/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Set working days/ }));

    // All seven, matching what the server gives a new full-timer — narrowing is
    // then a deliberate act rather than the starting point.
    expect(screen.getByLabelText("Sun start time")).toHaveValue("00:00");
    expect(screen.getByLabelText("Sat end time")).toHaveValue("23:59");
  });
});

describe("a casual member", () => {
  it("cannot be edited here", async () => {
    mockFetch(MON_WED);
    renderEditor({ employmentType: "casual" });

    await waitFor(() => {
      expect(screen.getByText(/theirs to set/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Save working days/ })).toBeNull();
    expect(screen.queryByLabelText("Mon start time")).toBeNull();
  });

  it("shows what they have said, so the admin can judge it", async () => {
    mockFetch(MON_WED);
    renderEditor({ employmentType: "casual" });

    await waitFor(() => {
      expect(screen.getByText("Mon, Wed")).toBeInTheDocument();
    });
  });

  it("says so when they have said nothing", async () => {
    mockFetch([]);
    renderEditor({ employmentType: "casual" });

    await waitFor(() => {
      expect(screen.getByText("No availability set.")).toBeInTheDocument();
    });
  });

  // The nudge that had no caller anywhere in the product until now.
  it("offers to ask them to review it", async () => {
    mockFetch(MON_WED);
    const onRequestReview = vi.fn();
    renderEditor({ employmentType: "casual", onRequestReview });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Ask them to review/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Ask them to review/ }));
    expect(onRequestReview).toHaveBeenCalledWith("u1");
  });

  it("offers nothing when the caller cannot send one", async () => {
    mockFetch(MON_WED);
    renderEditor({ employmentType: "casual" });

    await waitFor(() => {
      expect(screen.getByText(/theirs to set/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Ask them to review/ })).toBeNull();
  });
});

describe("employment type, not role, decides", () => {
  // A full-time MANAGER is contracted like anybody else; role is not the axis.
  it("treats an unset employment type as casual", async () => {
    mockFetch(MON_WED);
    renderEditor({ employmentType: null });

    await waitFor(() => {
      expect(screen.getByText(/theirs to set/)).toBeInTheDocument();
    });
  });
});
