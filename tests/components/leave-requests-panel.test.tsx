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
    expect(screen.getByText(/14 Aug 2026/)).toBeInTheDocument();
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
