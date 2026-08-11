/**
 * When an unanswered leave request starts running out of time.
 *
 * Two clocks, because there are two ways to be too late and they fail
 * independently: a manager who never looked (the SLA), and a date that arrived
 * before anybody needed to look (the horizon). Pinned with an injected `now`,
 * so none of these is a claim about the moment the suite happens to run.
 */
import { describe, it, expect } from "vitest";
import {
  LEAVE_ESCALATION_HOURS,
  LEAVE_SLA_HOURS,
  chaseStageFor,
  isClosingSoon,
} from "@/lib/leave-timing";
import { DEFAULT_HORIZON_DAYS } from "@/lib/scheduling-horizon";

const NOW = new Date("2026-08-11T04:00:00Z"); // noon in Singapore
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const row = (over: Partial<Parameters<typeof chaseStageFor>[0]> = {}) => ({
  // Far enough out that neither clock fires unless a test says so.
  date: new Date(NOW.getTime() + 90 * DAY),
  submittedAt: new Date(NOW.getTime() - HOUR),
  remindedAt: null,
  escalatedAt: null,
  ...over,
});

describe("running out of time", () => {
  it("is calm about a request made an hour ago for a date months away", () => {
    expect(isClosingSoon(row(), NOW)).toBe(false);
  });

  /*
   * The SLA half. A request nobody has looked at for two days is overdue
   * whether the leave is next week or next quarter — that is what makes it the
   * manager's problem rather than the calendar's.
   */
  it("fires once the SLA has passed, however distant the date", () => {
    const old = row({
      submittedAt: new Date(NOW.getTime() - (LEAVE_SLA_HOURS + 1) * HOUR),
    });
    expect(isClosingSoon(old, NOW)).toBe(true);
  });

  it("does not fire one hour short of the SLA", () => {
    const nearly = row({
      submittedAt: new Date(NOW.getTime() - (LEAVE_SLA_HOURS - 1) * HOUR),
    });
    expect(isClosingSoon(nearly, NOW)).toBe(false);
  });

  /*
   * The horizon half — the case the SLA alone misses entirely. Asked for on
   * Sunday night for next Tuesday: not overdue, and the shift is gone before it
   * becomes so.
   */
  it("fires for a date inside the horizon even if it was just submitted", () => {
    const soon = row({ date: new Date(NOW.getTime() + 3 * DAY) });
    expect(isClosingSoon(soon, NOW)).toBe(true);
  });

  it("is calm about a date one day beyond the horizon", () => {
    const beyond = row({
      date: new Date(NOW.getTime() + (DEFAULT_HORIZON_DAYS + 1) * DAY),
    });
    expect(isClosingSoon(beyond, NOW)).toBe(false);
  });

  /*
   * Rows written before the column existed carry no clock. The date half must
   * still apply rather than the whole rule failing open — otherwise every
   * historic request becomes permanently un-chaseable.
   */
  it("still uses the date when there is no submission time", () => {
    const legacy = row({ submittedAt: null, date: new Date(NOW.getTime() + DAY) });
    expect(isClosingSoon(legacy, NOW)).toBe(true);

    const legacyDistant = row({ submittedAt: null });
    expect(isClosingSoon(legacyDistant, NOW)).toBe(false);
  });
});

describe("what the sweep should do", () => {
  const overdue = () =>
    row({ submittedAt: new Date(NOW.getTime() - (LEAVE_SLA_HOURS + 1) * HOUR) });

  it("does nothing to a request that is not running out of time", () => {
    expect(chaseStageFor(row(), NOW)).toBe("none");
  });

  it("reminds an overdue request nobody has chased", () => {
    expect(chaseStageFor(overdue(), NOW)).toBe("remind");
  });

  /*
   * The reminder does not repeat on the next cron run. Without this the sweep
   * re-sends every fifteen minutes, which is how a notification channel becomes
   * one everybody filters.
   */
  it("says nothing again the moment after reminding", () => {
    const justChased = overdue();
    justChased.remindedAt = new Date(NOW.getTime() - HOUR);
    expect(chaseStageFor(justChased, NOW)).toBe("none");
  });

  it("escalates once the escalation window has passed", () => {
    const stale = overdue();
    stale.remindedAt = new Date(
      NOW.getTime() - (LEAVE_ESCALATION_HOURS + 1) * HOUR
    );
    expect(chaseStageFor(stale, NOW)).toBe("escalate");
  });

  /*
   * And then it stops. A request nobody ever answers is chased exactly twice;
   * there is no third stage and no cooldown that would produce one.
   */
  it("is finished once it has escalated", () => {
    const done = overdue();
    done.remindedAt = new Date(NOW.getTime() - 10 * DAY);
    done.escalatedAt = new Date(NOW.getTime() - 9 * DAY);
    expect(chaseStageFor(done, NOW)).toBe("none");
  });
});
