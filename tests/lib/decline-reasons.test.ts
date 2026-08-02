/**
 * Tests for the shared decline-reason list.
 *
 * The eight values used to be written out in three places — the Zod enum in
 * `validations.ts`, a hard-coded `<option>` list in the My Tasks page, and a
 * label map in `pdf-report.service.ts`. Nothing kept them in step, and the
 * failure was ugly from the staff member's side: a value the dropdown offered
 * but the schema refused produced "Validation failed" with no way to proceed,
 * on a screen whose only purpose is to say "I can't work this shift".
 *
 * Most of that risk is now carried by the compiler — the label maps are typed
 * `Record<DeclineReason, string>`, so a missing entry fails the build. These
 * tests cover what types cannot: that the two maps are actually different from
 * each other (someone "tidying up" could collapse them), and that stored values
 * from before the change still render.
 */
import { describe, it, expect } from "vitest";
import {
  DECLINE_REASONS,
  REASON_LABEL,
  REASON_PHRASE,
  isDeclineReason,
  reasonLabel,
} from "@/lib/decline-reasons";
import { rejectTaskSchema, withdrawTaskSchema } from "@/lib/validations";

describe("DECLINE_REASONS", () => {
  it("holds the eight agreed reasons", () => {
    expect(DECLINE_REASONS).toHaveLength(8);
  });

  it("has no duplicates", () => {
    expect(new Set(DECLINE_REASONS).size).toBe(DECLINE_REASONS.length);
  });

  it("keeps 'other' last", () => {
    // A list that opens with an escape hatch invites people to take it, and an
    // "other" rejection tells a manager nothing they can act on.
    expect(DECLINE_REASONS[DECLINE_REASONS.length - 1]).toBe("other");
  });

  it("uses snake_case keys throughout", () => {
    // They are stored in a database column and compared as literals in the
    // reporting service; a stray capital or space would only surface there.
    for (const reason of DECLINE_REASONS) {
      expect(reason).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe("The schemas and the list cannot drift apart", () => {
  it("rejectTaskSchema accepts every reason", () => {
    for (const reason of DECLINE_REASONS) {
      expect(rejectTaskSchema.safeParse({ rejectionReason: reason }).success).toBe(true);
    }
  });

  it("withdrawTaskSchema accepts every reason", () => {
    for (const reason of DECLINE_REASONS) {
      expect(withdrawTaskSchema.safeParse({ reason }).success).toBe(true);
    }
  });

  it("neither schema accepts a value outside the list", () => {
    expect(rejectTaskSchema.safeParse({ rejectionReason: "bad_weather" }).success).toBe(false);
    expect(withdrawTaskSchema.safeParse({ reason: "bad_weather" }).success).toBe(false);
  });
});

describe("The two label maps", () => {
  it("cover every reason", () => {
    for (const reason of DECLINE_REASONS) {
      expect(REASON_LABEL[reason]).toBeTruthy();
      expect(REASON_PHRASE[reason]).toBeTruthy();
    }
  });

  it("are deliberately different, and must stay that way", () => {
    // REASON_LABEL stands alone in a dropdown, so it is capitalised.
    // REASON_PHRASE goes inside a sentence in a generated report, so it is
    // lower case and plural. Collapsing them into one map would make one of the
    // two read wrongly, and it is the sort of duplication that looks like an
    // oversight.
    expect(REASON_LABEL.schedule_conflict).toBe("Schedule conflict");
    expect(REASON_PHRASE.schedule_conflict).toBe("schedule conflicts");
  });

  it("capitalises every UI label", () => {
    for (const reason of DECLINE_REASONS) {
      expect(REASON_LABEL[reason][0]).toBe(REASON_LABEL[reason][0].toUpperCase());
    }
  });

  it("keeps every prose label lower case", () => {
    for (const reason of DECLINE_REASONS) {
      expect(REASON_PHRASE[reason]).toBe(REASON_PHRASE[reason].toLowerCase());
    }
  });
});

describe("isDeclineReason", () => {
  it("recognises every listed reason", () => {
    for (const reason of DECLINE_REASONS) {
      expect(isDeclineReason(reason)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["", "Other", "bad_weather", "constructor", "toString"]) {
      expect(isDeclineReason(value)).toBe(false);
    }
  });
});

describe("reasonLabel", () => {
  it("renders a known reason as its UI label", () => {
    expect(reasonLabel("schedule_conflict")).toBe("Schedule conflict");
  });

  it("shows historic free text as it was written", () => {
    // Withdrawals recorded before reasons became structured hold whatever the
    // staff member typed. That is still what they said, so it is shown rather
    // than hidden or relabelled as "Other".
    expect(reasonLabel("Family emergency")).toBe("Family emergency");
  });

  it("tidies an unrecognised enum-like value rather than showing underscores", () => {
    expect(reasonLabel("bad_weather")).toBe("bad weather");
  });

  it("says so when there is no reason at all", () => {
    expect(reasonLabel(null)).toBe("No reason given");
    expect(reasonLabel(undefined)).toBe("No reason given");
    expect(reasonLabel("")).toBe("No reason given");
  });
});
