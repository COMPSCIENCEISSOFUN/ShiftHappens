// @vitest-environment jsdom
/**
 * The warning half of the model you chose.
 *
 * Leave binds on APPROVAL, with the manager told beforehand. Stage 1 shipped the
 * binding half only, so a manager could roster straight over an unanswered
 * request and the first either party heard of it was when the leave was approved
 * and the shift had to be unpicked — which is the option that was explicitly not
 * chosen.
 *
 * This is a warning, never a gate. The person is genuinely still rosterable, and
 * a manager who needs them may still say so.
 *
 * Only ever a request for a day OFF. A contracted member cannot ask to work a
 * day they are not contracted for — that is a change to the contract, not an
 * exception to it — so the flag has one direction rather than two.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PendingLeaveFlag,
  type LeaveOnThisShift,
  type Alternative,
} from "@/components/tasks/pending-leave-flag";

function leave(overrides: Partial<LeaveOnThisShift> = {}): LeaveOnThisShift {
  return {
    id: "lr1",
    membershipId: "m1",
    date: "2026-08-14T00:00:00.000Z",
    reason: "Medical appointment",
    ...overrides,
  };
}

const ALTERNATIVES: Alternative[] = [
  { membershipId: "m2", name: "Jamie Park", rank: 1 },
  { membershipId: "m3", name: "Casey Brown", rank: 2 },
];

describe("what it says", () => {
  it("names the day and that nobody has answered", () => {
    render(<PendingLeaveFlag leave={leave()} alternatives={[]} />);
    expect(screen.getByText(/Asked Fri 14 Aug off/)).toBeInTheDocument();
    expect(screen.getByText(/awaiting approval/)).toBeInTheDocument();
  });

  it("shows the reason when one was given", () => {
    render(<PendingLeaveFlag leave={leave()} alternatives={[]} />);
    expect(screen.getByText("Medical appointment")).toBeInTheDocument();
  });

  it("says nothing extra when none was", () => {
    render(<PendingLeaveFlag leave={leave({ reason: null })} alternatives={[]} />);
    expect(screen.queryByText("Medical appointment")).toBeNull();
  });
});

describe("the alternative", () => {
  it("offers the best-ranked candidate", () => {
    render(<PendingLeaveFlag leave={leave()} alternatives={ALTERNATIVES} />);
    expect(
      screen.getByRole("button", { name: /Pick Jamie Park instead/ })
    ).toBeInTheDocument();
  });

  it("names the rank, so the manager can see where it came from", () => {
    render(<PendingLeaveFlag leave={leave()} alternatives={ALTERNATIVES} />);
    expect(screen.getByRole("button", { name: /ranked #1/ })).toBeInTheDocument();
  });

  it("hands back the alternative's id", async () => {
    const onPick = vi.fn();
    render(
      <PendingLeaveFlag leave={leave()} alternatives={ALTERNATIVES} onPick={onPick} />
    );

    await userEvent.click(screen.getByRole("button", { name: /Pick Jamie Park/ }));
    expect(onPick).toHaveBeenCalledWith("m2");
  });

  // "No alternatives available" is not worth a line — the manager can see the
  // rest of the list for themselves.
  it("offers nothing when there is nobody to offer", () => {
    render(<PendingLeaveFlag leave={leave()} alternatives={[]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

});

describe("it does not gate anything", () => {
  /*
   * The flag renders INSIDE the candidate's own <label>, so a click that
   * bubbled would tick the very person being warned about — the opposite of
   * what the button says. Verified by asserting the click event is stopped.
   */
  it("does not tick the candidate it is warning about", async () => {
    const onLabelClick = vi.fn();
    const onPick = vi.fn();

    render(
      <label onClick={onLabelClick}>
        <input type="checkbox" />
        <PendingLeaveFlag
          leave={leave()}
          alternatives={ALTERNATIVES}
          onPick={onPick}
        />
      </label>
    );

    await userEvent.click(screen.getByRole("button", { name: /Pick Jamie Park/ }));

    expect(onPick).toHaveBeenCalled();
    expect(onLabelClick).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
