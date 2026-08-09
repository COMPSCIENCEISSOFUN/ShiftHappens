/**
 * Tests for the shared certification display helpers.
 *
 * These must give the same answer on a developer machine (Asia/Singapore) and
 * on Vercel (UTC), so every assertion is against a fixed UTC instant with a
 * known Singapore wall-clock equivalent. `npm run test:utc` runs the same file
 * under TZ=UTC; if anything here reads the ambient zone, the two disagree.
 *
 * Reference: Singapore is UTC+8 year-round (no DST).
 *   2026-07-28T02:00:00Z  ==  2026-07-28 10:00 SGT
 *   2026-07-27T16:00:00Z  ==  2026-07-28 00:00 SGT  ← start of the SGT day
 *   2026-07-28T16:00:00Z  ==  2026-07-29 00:00 SGT  ← next SGT day
 */
import { describe, it, expect } from "vitest";
import {
  EXPIRY_WARNING_DAYS,
  REJECTION_NOTES_MAX,
  REJECTION_REASONS,
  REJECTION_REASON_LABELS,
  certificationDisplayState,
  dateInputToIso,
  daysUntilExpiry,
  formatCertDate,
  isExpiryNotifyDay,
  isoToDateInput,
  relativeTime,
} from "@/lib/certification-display";
import { CERTIFICATION_REJECTION_REASONS } from "@/lib/validations";

/** 10:00 SGT on 28 Jul 2026 — the fixed "now" for every relative assertion. */
const NOW = new Date("2026-07-28T02:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant at a Singapore wall-clock time, offset written out on purpose. */
function sgt(wallClock: string): Date {
  const withSeconds = wallClock.length === 16 ? `${wallClock}:00` : wallClock;
  return new Date(`${withSeconds}+08:00`);
}

describe("certification display helpers", () => {
  /* ---------------------------------------------------------------- */

  describe("rejection reasons", () => {
    /**
     * This is the test that lets `certification-display.ts` write the reason
     * values out literally instead of importing them from the Zod schema (which
     * would drag Zod into the browser bundle). If they ever drift, the reason
     * picker offers a value the API refuses with a 400.
     */
    it("offers exactly the reasons the API accepts, in the same set", () => {
      expect([...REJECTION_REASONS.map((r) => r.value)].sort()).toEqual(
        [...CERTIFICATION_REJECTION_REASONS].sort()
      );
    });

    it("gives every reason a distinct label and a description", () => {
      const labels = REJECTION_REASONS.map((r) => r.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const reason of REJECTION_REASONS) {
        expect(reason.description.length).toBeGreaterThan(0);
      }
    });

    it("derives the label lookup from the same list", () => {
      for (const reason of REJECTION_REASONS) {
        expect(REJECTION_REASON_LABELS[reason.value]).toBe(reason.label);
      }
      expect(Object.keys(REJECTION_REASON_LABELS)).toHaveLength(
        REJECTION_REASONS.length
      );
    });

    it("caps notes at the length the API validates against", () => {
      // validations.ts: rejectionNotes: z.string().max(500)
      expect(REJECTION_NOTES_MAX).toBe(500);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("certificationDisplayState", () => {
    it("passes non-verified statuses straight through", () => {
      // A pending submission with a lapsed date is still pending — that is the
      // thing the reviewer has to act on, not the expiry.
      const longGone = sgt("2020-01-01T00:00");
      expect(certificationDisplayState("pending", longGone, NOW)).toBe("pending");
      expect(certificationDisplayState("rejected", longGone, NOW)).toBe(
        "rejected"
      );
      expect(certificationDisplayState("revoked", longGone, NOW)).toBe("revoked");
    });

    it("does not relabel an unrecognised status", () => {
      // Silently calling it "pending" would hide a data problem.
      expect(certificationDisplayState("something_new", null, NOW)).toBe(
        "something_new"
      );
    });

    it("treats a verified certificate with no expiry as verified", () => {
      expect(certificationDisplayState("verified", null, NOW)).toBe("verified");
      expect(certificationDisplayState("verified", undefined, NOW)).toBe(
        "verified"
      );
    });

    it("treats an unparseable expiry as verified rather than expired", () => {
      // Better to under-warn than to badge a valid certificate "expired" because
      // of a malformed string.
      expect(certificationDisplayState("verified", "not a date", NOW)).toBe(
        "verified"
      );
    });

    it("marks a verified certificate expired once its expiry instant passes", () => {
      const oneMsAgo = new Date(NOW.getTime() - 1);
      expect(certificationDisplayState("verified", oneMsAgo, NOW)).toBe("expired");
    });

    it("marks it expired at exactly the expiry instant", () => {
      // getValidCertifications uses `expiryDate > now`, so equality is expired.
      // The badge has to agree with the query that gates eligibility.
      expect(certificationDisplayState("verified", NOW, NOW)).toBe("expired");
    });

    it("marks it expiring inside the warning window", () => {
      const inTenDays = new Date(NOW.getTime() + 10 * DAY_MS);
      expect(certificationDisplayState("verified", inTenDays, NOW)).toBe(
        "expiring"
      );
    });

    it("marks it expiring later today", () => {
      // 23:00 SGT on the 28th, from 10:00 SGT on the 28th.
      expect(
        certificationDisplayState("verified", sgt("2026-07-28T23:00"), NOW)
      ).toBe("expiring");
    });

    it("still says verified beyond the warning window", () => {
      const wellClear = new Date(
        NOW.getTime() + (EXPIRY_WARNING_DAYS + 5) * DAY_MS
      );
      expect(certificationDisplayState("verified", wellClear, NOW)).toBe(
        "verified"
      );
    });

    it("measures the warning window from the organisation's midnight", () => {
      // The window is [SGT midnight today, +30 days). From 10:00 SGT on 28 Jul
      // that boundary is 27 Aug 00:00 SGT, NOT 27 Aug 10:00. A certificate
      // expiring 27 Aug 00:00 SGT is the last one inside the window; one
      // expiring an hour later is outside it. Anchoring to "now" instead would
      // make the set of expiring certificates shift through the day.
      expect(
        certificationDisplayState("verified", sgt("2026-08-27T00:00"), NOW)
      ).toBe("expiring");
      expect(
        certificationDisplayState("verified", sgt("2026-08-27T01:00"), NOW)
      ).toBe("verified");
    });

    it("accepts an ISO string as readily as a Date", () => {
      const inTenDays = new Date(NOW.getTime() + 10 * DAY_MS).toISOString();
      expect(certificationDisplayState("verified", inTenDays, NOW)).toBe(
        "expiring"
      );
    });
  });

  /* ---------------------------------------------------------------- */

  describe("daysUntilExpiry", () => {
    it("returns 0 for an expiry later the same Singapore day", () => {
      expect(daysUntilExpiry(sgt("2026-07-28T23:59"), NOW)).toBe(0);
    });

    it("counts calendar days, not elapsed 24-hour blocks", () => {
      // 01:00 SGT on the 29th is only 15 hours after 10:00 SGT on the 28th, but
      // it is the next day — "expires in 1 day", not "in 0 days".
      expect(daysUntilExpiry(sgt("2026-07-29T01:00"), NOW)).toBe(1);
    });

    it("counts across a UTC day boundary correctly", () => {
      // 2026-07-28T16:00:00Z is 29 Jul 00:00 SGT. Reading the day in UTC would
      // call this "today"; in Singapore it is tomorrow.
      expect(daysUntilExpiry(new Date("2026-07-28T16:00:00.000Z"), NOW)).toBe(1);
    });

    it("goes negative once the certificate has lapsed", () => {
      expect(daysUntilExpiry(sgt("2026-07-25T09:00"), NOW)).toBe(-3);
    });

    it("returns 0 for an unparseable date", () => {
      expect(daysUntilExpiry("not a date", NOW)).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("formatCertDate", () => {
    it("formats a Singapore date as day, short month, year", () => {
      expect(formatCertDate(sgt("2026-06-12T00:00"))).toBe("12 Jun 2026");
    });

    it("names the Singapore day, not the UTC one", () => {
      // 2026-06-11T16:00:00Z is 12 Jun 00:00 SGT. Formatting in UTC — which is
      // what the server's locale would do — would print "11 Jun".
      expect(formatCertDate("2026-06-11T16:00:00.000Z")).toBe("12 Jun 2026");
    });

    it("uses three letters for every month, including September", () => {
      // Regression: en-GB renders September as "Sept" and everything else with
      // three letters, so a list of expiry dates came out visibly ragged.
      expect(formatCertDate(sgt("2027-09-03T00:00"))).toBe("3 Sep 2027");

      const lengths = new Set(
        Array.from({ length: 12 }, (_, m) =>
          formatCertDate(sgt(`2026-${String(m + 1).padStart(2, "0")}-15T00:00`))
            .split(" ")[1].length
        )
      );
      expect(lengths).toEqual(new Set([3]));
    });

    it("does not zero-pad the day", () => {
      expect(formatCertDate(sgt("2026-06-05T00:00"))).toBe("5 Jun 2026");
    });

    it("renders a dash for missing or unparseable values", () => {
      expect(formatCertDate(null)).toBe("—");
      expect(formatCertDate(undefined)).toBe("—");
      expect(formatCertDate("")).toBe("—");
      expect(formatCertDate("not a date")).toBe("—");
    });
  });

  /* ---------------------------------------------------------------- */

  describe("date input conversion", () => {
    it("anchors a date input to Singapore midnight", () => {
      // Typing 12 Jun must store the instant Singapore's 12 Jun begins, which
      // is 16:00 UTC on the 11th — not UTC midnight on the 12th.
      expect(dateInputToIso("2026-06-12")).toBe("2026-06-11T16:00:00.000Z");
    });

    it("round-trips a typed date back to the same input value", () => {
      // The property that matters to the user: what they typed is what they see.
      for (const typed of [
        "2026-01-01",
        "2026-06-12",
        "2026-12-31",
        "2028-02-29",
      ]) {
        const stored = dateInputToIso(typed);
        expect(stored).not.toBeNull();
        expect(isoToDateInput(stored as string)).toBe(typed);
      }
    });

    it("returns null for a blank or unparseable input", () => {
      // The caller omits the field entirely rather than posting "Invalid Date",
      // which z.string().datetime() rejects with a generic 400.
      expect(dateInputToIso("")).toBeNull();
      expect(dateInputToIso("not a date")).toBeNull();
    });

    it("produces a value z.string().datetime() accepts", () => {
      const stored = dateInputToIso("2026-06-12");
      expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("formats a stored instant for a date input in Singapore terms", () => {
      expect(isoToDateInput("2026-06-11T16:00:00.000Z")).toBe("2026-06-12");
      expect(isoToDateInput(null)).toBe("");
      expect(isoToDateInput("not a date")).toBe("");
    });
  });

  /* ---------------------------------------------------------------- */

  describe("relativeTime", () => {
    it("describes recent instants in the largest sensible unit", () => {
      expect(relativeTime(new Date(NOW.getTime() - 30 * 1000), NOW)).toBe(
        "just now"
      );
      expect(relativeTime(new Date(NOW.getTime() - 60 * 1000), NOW)).toBe(
        "1 minute ago"
      );
      expect(relativeTime(new Date(NOW.getTime() - 5 * 60 * 1000), NOW)).toBe(
        "5 minutes ago"
      );
      expect(relativeTime(new Date(NOW.getTime() - 60 * 60 * 1000), NOW)).toBe(
        "1 hour ago"
      );
      expect(relativeTime(new Date(NOW.getTime() - 2 * DAY_MS), NOW)).toBe(
        "2 days ago"
      );
    });

    it("falls back to an absolute date beyond a month", () => {
      // "47 days ago" tells a reviewer nothing useful; the date does.
      expect(relativeTime(sgt("2026-05-01T09:00"), NOW)).toBe("1 May 2026");
    });

    it("returns a dash for an unparseable value", () => {
      expect(relativeTime("not a date", NOW)).toBe("—");
    });
  });
});

/**
 * When an expiring certificate is worth mentioning.
 *
 * The scan runs daily and suppressed a repeat only within the same day, so a
 * certificate entering the 30-day window produced roughly thirty notifications
 * — one every morning until it expired. The docstring called that "idempotent
 * within a day", which was true and was the problem.
 */
describe("isExpiryNotifyDay", () => {
  it("flags the marks and nothing between them", () => {
    expect(isExpiryNotifyDay(30)).toBe(true);
    expect(isExpiryNotifyDay(14)).toBe(true);
    expect(isExpiryNotifyDay(7)).toBe(true);
    expect(isExpiryNotifyDay(3)).toBe(true);
    expect(isExpiryNotifyDay(1)).toBe(true);
    // The day it actually expires, which is the one that costs eligibility.
    expect(isExpiryNotifyDay(0)).toBe(true);

    for (const quiet of [29, 20, 15, 8, 5, 2]) {
      expect(isExpiryNotifyDay(quiet), `${quiet} days should be quiet`).toBe(false);
    }
  });

  /*
   * The whole point. Walking every day of the window must produce a handful of
   * notifications, not one per day — asserted as a count rather than by listing
   * the marks again, so adding a mark is a deliberate change to this number.
   */
  it("turns a month of daily messages into six", () => {
    const days = Array.from({ length: EXPIRY_WARNING_DAYS + 1 }, (_, i) => i);
    expect(days.filter(isExpiryNotifyDay)).toHaveLength(6);
  });

  it("says nothing about a certificate with no expiry date", () => {
    expect(isExpiryNotifyDay(null)).toBe(false);
  });

  // Outside the warning window entirely — the scan does not fetch these, but
  // the predicate should not claim them either.
  it("says nothing beyond the warning window", () => {
    expect(isExpiryNotifyDay(45)).toBe(false);
  });
});
