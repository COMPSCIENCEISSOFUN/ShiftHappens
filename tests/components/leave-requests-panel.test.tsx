// @vitest-environment jsdom
/**
 * The screen that makes the leave endpoints reachable.
 *
 * Approve and reject shipped as service methods and routes with nothing calling
 * them: a full-time member could request leave, managers were notified, and
 * there was no way in the product to answer. That is the fourth instance of
 * built-and-uncalled in this codebase — after `candidateEffect`, `mondayOf` and
 * `deleteOverride` — and the first written deliberately, which makes it the
 * least excusable of the four.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LeaveRequestsPanel,
  type PendingLeave,
} from "@/components/dashboard/leave-requests-panel";

function request(overrides: Partial<PendingLeave> = {}): PendingLeave {
  return {
    id: "lr1",
    date: "2026-08-14T00:00:00.000Z",
    isAvailable: false,
    reason: "Medical appointment",
    lapsed: false,
    membership: {
      id: "m1",
      user: { id: "u1", name: "Alex Rivera", email: "alex@oceangrill.com" },
    },
    ...overrides,
  };
}

describe("what a reviewer is shown", () => {
  it("names the person, the date, and what they asked for", () => {
    render(<LeaveRequestsPanel requests={[request()]} onDecide={vi.fn()} />);

    expect(screen.getByText(/Alex Rivera/)).toBeInTheDocument();
    expect(screen.getByText(/asked off/)).toBeInTheDocument();
    /*
     * Passing on the machine that wrote it, and nowhere guaranteed.
     *
     * This panel formats in the reader's locale now, and "14 Aug 2026" happens
     * to be what this machine produces. It was green in the run that turned
     * five sibling assertions red, which is the worst way for a fragile test to
     * behave: it survives the change that proves it is fragile.
     *
     * The day and the year are the claim; the order and the month's spelling
     * are the reader's.
     */
    expect(screen.getByText(/\b14\b/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  /*
   * There is only one direction now. A contracted member may ask for a day OFF
   * and never to work one on — asking to work a day you are not contracted for
   * is a change to the contract rather than an exception to it. Casual members
   * can still widen their own availability, but theirs is written approved and
   * never reaches this queue.
   */
  it("reads as a day-off request whatever the row says", () => {
    render(
      <LeaveRequestsPanel
        requests={[request({ isAvailable: true })]}
        onDecide={vi.fn()}
      />
    );
    expect(screen.getByText(/asked off/)).toBeInTheDocument();
    expect(screen.queryByText(/asked to work/)).toBeNull();
  });

  // The reason is often the whole decision; a manager approving without it is
  // guessing.
  it("shows the reason", () => {
    render(<LeaveRequestsPanel requests={[request()]} onDecide={vi.fn()} />);
    expect(screen.getByText("Medical appointment")).toBeInTheDocument();
  });

  it("says so when no reason was given", () => {
    render(
      <LeaveRequestsPanel requests={[request({ reason: null })]} onDecide={vi.fn()} />
    );
    expect(screen.getByText("No reason given")).toBeInTheDocument();
  });

  it("falls back to the email when a member has no name", () => {
    render(
      <LeaveRequestsPanel
        requests={[
          request({
            membership: {
              id: "m1",
              user: { id: "u1", name: null, email: "alex@oceangrill.com" },
            },
          }),
        ]}
        onDecide={vi.fn()}
      />
    );
    expect(screen.getByText(/alex@oceangrill\.com/)).toBeInTheDocument();
  });
});

describe("deciding", () => {
  it("approves", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<LeaveRequestsPanel requests={[request()]} onDecide={onDecide} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Approve leave for Alex Rivera/ })
    );
    expect(onDecide).toHaveBeenCalledWith("lr1", "approved");
  });

  it("declines", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<LeaveRequestsPanel requests={[request()]} onDecide={onDecide} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Decline leave for Alex Rivera/ })
    );
    expect(onDecide).toHaveBeenCalledWith("lr1", "rejected");
  });

  /*
   * A second click before the first resolves would send a second verdict, and
   * the service refuses an already-reviewed request — so the manager would see
   * an error for an action that worked. Both buttons lock, not just the one
   * pressed: approve-then-decline in the same instant is the same problem.
   */
  it("locks both buttons while a decision is in flight", async () => {
    let release: () => void = () => {};
    const onDecide = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    render(<LeaveRequestsPanel requests={[request()]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));

    expect(screen.getByRole("button", { name: /Approve/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Decline/ })).toBeDisabled();

    release();
  });

  it("leaves other rows usable while one is deciding", async () => {
    let release: () => void = () => {};
    const onDecide = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    render(
      <LeaveRequestsPanel
        requests={[
          request(),
          request({
            id: "lr2",
            membership: {
              id: "m2",
              user: { id: "u2", name: "Jamie Park", email: "jamie@x.test" },
            },
          }),
        ]}
        onDecide={onDecide}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Approve leave for Alex Rivera/ })
    );

    expect(
      screen.getByRole("button", { name: /Approve leave for Jamie Park/ })
    ).toBeEnabled();

    release();
  });
});

describe("nothing to review", () => {
  /*
   * Renders nothing at all — no heading, no "all clear" card. This sits among a
   * manager's action items, and a list that announces its own emptiness trains
   * people to scroll past the place real actions appear.
   */
  it("renders nothing", () => {
    const { container } = render(
      <LeaveRequestsPanel requests={[]} onDecide={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("a request nobody answered in time", () => {
  const lapsed = (extra: Partial<PendingLeave> = {}) =>
    request({ id: "old", lapsed: true, date: "2026-07-02T00:00:00.000Z", ...extra });

  /*
   * Approve and Decline both send the member a notification. On a day that has
   * already been and gone, either one is a message about an outcome that did
   * not occur — so the row offers neither. The service refuses them too; this
   * is the screen agreeing with the service rather than relying on it.
   */
  it("offers only Dismiss", () => {
    render(<LeaveRequestsPanel requests={[lapsed()]} onDecide={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /Dismiss lapsed leave request/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Decline/ })).toBeNull();
  });

  it("says nobody answered, rather than just that it is old", () => {
    render(<LeaveRequestsPanel requests={[lapsed()]} onDecide={vi.fn()} />);

    // "Lapsed" alone reads as though the system cancelled it. It did not.
    expect(screen.getByText(/passed without an answer/)).toBeInTheDocument();
  });

  it("sends the dismissal, not a verdict", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<LeaveRequestsPanel requests={[lapsed()]} onDecide={onDecide} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Dismiss lapsed leave request/ })
    );

    expect(onDecide).toHaveBeenCalledWith("old", "dismissed");
  });

  /*
   * The server orders by date ascending, which puts the oldest first — so the
   * rows that can no longer be acted on led the queue and pushed the live ones
   * down. Lapsed requests have the earliest dates by definition, so this is not
   * an edge case, it is what the queue looked like.
   */
  it("sorts below the live ones despite having the earlier date", () => {
    render(
      <LeaveRequestsPanel
        requests={[lapsed(), request({ id: "live" })]}
        onDecide={vi.fn()}
      />
    );

    const rows = screen.getAllByText(/asked off on/);
    expect(rows[0].textContent).toContain("Aug");
    expect(rows[1].textContent).toContain("Jul");
  });

  /*
   * The heading counts decisions, not rows. A manager reading "2" needs it to
   * mean two things they can do something about — the sidebar badge is filtered
   * the same way, off the same server-computed flag.
   */
  it("is counted apart from the work still waiting", () => {
    render(
      <LeaveRequestsPanel
        requests={[lapsed(), request({ id: "live" })]}
        onDecide={vi.fn()}
      />
    );

    expect(screen.getByText(/Leave requests \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 lapsed/)).toBeInTheDocument();
  });
});
