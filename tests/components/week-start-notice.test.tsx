// @vitest-environment jsdom
/**
 * Saying when a chosen week does not start on a Monday.
 *
 * `mondayOf` and `isMonday` were written and tested when the auto-schedule page
 * was built, then left uncalled. The recorded decision was that silently moving
 * a date somebody just picked is worse than telling them — right, but only the
 * half needing no work got done. The page neither snapped nor said anything, so
 * a Wednesday produced a Wednesday-to-Tuesday roster with nothing marking it as
 * unusual.
 *
 * Rendered rather than asserted through the helpers, because the helpers were
 * already tested and still shipped nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WeekStartNotice } from "@/components/schedule/week-start-notice";

// 2026-08-03 is a Monday; the 5th is the Wednesday of the same week.
const MONDAY = "2026-08-03";
const WEDNESDAY = "2026-08-05";
const SUNDAY = "2026-08-09";

describe("when the week starts on a Monday", () => {
  it("says nothing at all", () => {
    const { container } = render(
      <WeekStartNotice weekStart={MONDAY} onUseMonday={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("when it does not", () => {
  it("names the day the user actually picked", () => {
    render(<WeekStartNotice weekStart={WEDNESDAY} onUseMonday={() => {}} />);
    expect(screen.getByText(/starts on a Wednesday/)).toBeInTheDocument();
  });

  it("offers the Monday of that same week", () => {
    render(<WeekStartNotice weekStart={WEDNESDAY} onUseMonday={() => {}} />);
    expect(
      screen.getByRole("button", { name: /Mon 3 Aug/ })
    ).toBeInTheDocument();
  });

  /*
   * Sunday belongs to the week that STARTED on the preceding Monday, not the
   * one about to start. Getting this backwards would offer to move the roster
   * six days forward rather than one day back — and `mondayOf` handles Sunday
   * as the special case precisely because `getDay()` calls it 0.
   */
  it("treats Sunday as the end of its week, not the start of the next", () => {
    render(<WeekStartNotice weekStart={SUNDAY} onUseMonday={() => {}} />);
    expect(
      screen.getByRole("button", { name: /Mon 3 Aug/ })
    ).toBeInTheDocument();
  });

  it("hands the Monday back when the offer is taken", async () => {
    const onUseMonday = vi.fn();
    render(<WeekStartNotice weekStart={WEDNESDAY} onUseMonday={onUseMonday} />);

    await userEvent.click(screen.getByRole("button", { name: /Mon 3 Aug/ }));
    expect(onUseMonday).toHaveBeenCalledWith(MONDAY);
  });

  // Informative, not obstructive: a seven-day window from a Wednesday is a
  // legitimate thing to want, and confirmSchedule re-checks headcount so two
  // overlapping drafts cannot double-assign anyone.
  it("does not block anything — it is one sentence and one button", () => {
    render(<WeekStartNotice weekStart={WEDNESDAY} onUseMonday={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("stays out of the way while a draft is generating", () => {
    render(
      <WeekStartNotice weekStart={WEDNESDAY} onUseMonday={() => {}} disabled />
    );
    expect(screen.getByRole("button", { name: /Mon 3 Aug/ })).toBeDisabled();
  });
});

describe("a date that is not a date", () => {
  /*
   * The date input can hold a half-typed value. The page already says "Pick a
   * date to choose a week" for that, and a second message guessing at a weekday
   * would be noise on top of it.
   */
  it("says nothing rather than guessing", () => {
    for (const value of ["", "2026-08", "not-a-date"]) {
      const { container } = render(
        <WeekStartNotice weekStart={value} onUseMonday={() => {}} />
      );
      expect(container).toBeEmptyDOMElement();
    }
  });
});
