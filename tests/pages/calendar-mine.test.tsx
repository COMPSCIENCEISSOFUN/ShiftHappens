// @vitest-environment jsdom
/**
 * The Mine / Everyone toggle on the team calendar.
 *
 * ## Why it exists
 *
 * A manager is rostered AND can open the team calendar, so they held two: this
 * one, and My Schedule drawing the same week already filtered to them. This
 * toggle answers "what does MY week look like" without hunting for your own
 * name among everyone else's.
 *
 * It was built to make a SUBTRACTION safe — the sidebar stopped offering My
 * Schedule to anybody who could open Calendar. That subtraction has since been
 * reversed, because My Schedule grew the calendar subscribe link and a rostered
 * manager could no longer reach it. The toggle stays and stands on its own: a
 * manager looking at the team's week still wants to pick their own shifts out
 * of it without changing page.
 *
 * ## The thing that would be easy to get wrong
 *
 * Deciding "mine" by NAME. The task payload has always carried the assignee's
 * `user.id` — `findByOrganizationId` selects it and nothing strips it — but
 * this page's own interface declared only `name`, so the id was invisible to
 * anybody reading the file and the obvious implementation was a string compare.
 * Two people can share a name, and this is a screen somebody plans a week on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CalendarPage from "@/app/(app)/org/[orgId]/calendar/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({ can: () => true, canAny: () => true, loading: false }),
}));

const ME = "u-me";
const SOMEBODY_ELSE = "u-other";

/** A scheduled shift assigned to one person. */
function shift(
  id: string,
  title: string,
  assigneeId: string | null,
  assigneeName = "Alex Rivera"
) {
  const day = new Date();
  day.setHours(10, 0, 0, 0);
  const end = new Date(day);
  end.setHours(12, 0, 0, 0);

  return {
    id,
    title,
    status: "open",
    priority: "medium",
    requiredHeadcount: 1,
    scheduledStart: day.toISOString(),
    scheduledEnd: end.toISOString(),
    department: null,
    assignments: assigneeId
      ? [
          {
            id: `a-${id}`,
            status: "accepted",
            membership: { user: { id: assigneeId, name: assigneeName } },
          },
        ]
      : [],
  };
}

function mockApi(tasks: unknown[], profileId: string | null = ME) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = String(url);
      if (path.includes("/api/profile")) {
        return Promise.resolve({
          ok: profileId !== null,
          json: () => Promise.resolve(profileId ? { id: profileId } : {}),
        } as Response);
      }
      const body = path.includes("/tasks")
        ? tasks
        : path.includes("/settings/display")
          ? { operatingHoursStart: 8, operatingHoursEnd: 22 }
          : [];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

/** The Mine toggle, whichever way round it is currently reading. */
function toggle() {
  return screen.queryByRole("button", { name: /my shifts|everyone/i });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filtering the calendar to your own shifts", () => {
  it("shows everybody's shifts to begin with", async () => {
    mockApi([shift("t1", "My prep shift", ME), shift("t2", "Bar close", SOMEBODY_ELSE)]);
    render(<CalendarPage />);

    expect(await screen.findByText("My prep shift")).toBeInTheDocument();
    expect(screen.getByText("Bar close")).toBeInTheDocument();
  });

  it("drops everybody else's when switched on", async () => {
    mockApi([shift("t1", "My prep shift", ME), shift("t2", "Bar close", SOMEBODY_ELSE)]);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    await userEvent.click(toggle()!);

    expect(screen.getByText("My prep shift")).toBeInTheDocument();
    expect(screen.queryByText("Bar close")).not.toBeInTheDocument();
  });

  it("brings them back when switched off again", async () => {
    mockApi([shift("t1", "My prep shift", ME), shift("t2", "Bar close", SOMEBODY_ELSE)]);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    await userEvent.click(toggle()!);
    await userEvent.click(toggle()!);

    expect(screen.getByText("Bar close")).toBeInTheDocument();
  });

  /*
   * The id, not the name. A shift belonging to a different person who happens
   * to share the reader's name must not appear as theirs — which is exactly
   * what a string compare would have produced, and the page's own type made
   * that the obvious implementation by hiding the id.
   */
  it("does not claim a namesake's shift", async () => {
    mockApi([
      shift("t1", "My prep shift", ME, "Alex Rivera"),
      shift("t2", "Somebody else's", SOMEBODY_ELSE, "Alex Rivera"),
    ]);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    await userEvent.click(toggle()!);

    expect(screen.queryByText("Somebody else's")).not.toBeInTheDocument();
  });

  // A declined shift is not yours. Same rule that decides whether an assignment
  // occupies a headcount slot, rather than a second opinion about it.
  it("does not count a shift you declined", async () => {
    const declined = shift("t2", "Declined shift", ME);
    declined.assignments[0].status = "rejected";
    mockApi([shift("t1", "My prep shift", ME), declined]);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    await userEvent.click(toggle()!);

    expect(screen.queryByText("Declined shift")).not.toBeInTheDocument();
  });
});

/**
 * When the toggle should not be there at all.
 *
 * It is offered from the DATA — does this person hold any shift — rather than
 * from a role. That answers the real question ("would this show them
 * anything"), needs no extra request, and does not depend on a role string that
 * a custom role can move.
 */
describe("who is offered the toggle", () => {
  it("hides it from somebody who holds no shifts", async () => {
    mockApi([shift("t1", "Bar close", SOMEBODY_ELSE)]);
    render(<CalendarPage />);

    await screen.findByText("Bar close");
    expect(toggle()).toBeNull();
  });

  it("offers it to somebody who does", async () => {
    mockApi([shift("t1", "My prep shift", ME)]);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    expect(toggle()).toBeInTheDocument();
  });

  /*
   * A failed profile lookup leaves the reader unidentified. Showing the toggle
   * then would filter the board down to nothing and read as a broken calendar
   * rather than as an honest empty one.
   */
  it("hides it when the caller could not be identified", async () => {
    mockApi([shift("t1", "My prep shift", ME)], null);
    render(<CalendarPage />);

    await screen.findByText("My prep shift");
    expect(toggle()).toBeNull();
  });
});
