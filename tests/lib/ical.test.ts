/**
 * iCalendar serialisation, and the four rules that are invisible until a real
 * client refuses the file.
 *
 * Every one of these is a case where the output LOOKS correct in a terminal.
 * That is the argument for testing the serialiser rather than eyeballing a
 * download: "it opened on my Mac" tests one parser, and the failures here are
 * parser-specific by nature.
 */
import { describe, it, expect } from "vitest";
import {
  buildCalendar,
  escapeText,
  foldLine,
  formatUtc,
  type CalendarEvent,
} from "@/lib/ical";

const NOW = new Date("2026-08-11T04:00:00Z");

const shift = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  uid: "assignment-abc@smart-task-allocation",
  start: new Date("2026-08-14T02:00:00Z"),
  end: new Date("2026-08-14T06:00:00Z"),
  summary: "Morning prep",
  status: "confirmed",
  ...over,
});

describe("timestamps", () => {
  it("writes UTC basic format with the Z", () => {
    expect(formatUtc(new Date("2026-08-14T02:03:04Z"))).toBe("20260814T020304Z");
  });

  it("pads every field", () => {
    // 20260901T000000Z, not 202691T00Z — a client reading a short field either
    // rejects the file or lands on a different day.
    expect(formatUtc(new Date("2026-09-01T00:00:00Z"))).toBe("20260901T000000Z");
  });

  /*
   * No VTIMEZONE, deliberately: a shift at 10:00 Singapore is emitted as
   * 02:00Z, and the client renders it in whatever zone its owner is in. That is
   * also the right answer for somebody reading their rota abroad.
   */
  it("keeps the instant rather than a wall clock", () => {
    expect(formatUtc(new Date("2026-08-14T10:00:00+08:00"))).toBe(
      "20260814T020000Z"
    );
  });
});

describe("escaping TEXT values", () => {
  it("escapes the three structural characters", () => {
    expect(escapeText("a;b,c\\d")).toBe("a\\;b\\,c\\\\d");
  });

  /*
   * Backslash first, or the escapes introduced for `;` and `,` get escaped in
   * turn and the client shows the backslashes.
   */
  it("does not double-escape its own escapes", () => {
    expect(escapeText("100% \\ done")).toBe("100% \\\\ done");
  });

  it("turns real newlines into the literal escape", () => {
    expect(escapeText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeText("crlf\r\nhere")).toBe("crlf\\nhere");
  });

  /*
   * The failure this prevents: a shift note reading "Bring keys; ask for Mo"
   * has a semicolon, which is a parameter separator. Unescaped, everything
   * after it is read as structure and vanishes from the event.
   */
  it("survives a realistic note", () => {
    expect(escapeText("Bring keys; ask for Mo, then start")).toBe(
      "Bring keys\\; ask for Mo\\, then start"
    );
  });
});

describe("line folding", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Morning prep")).toBe("SUMMARY:Morning prep");
  });

  it("folds a long line with a leading space on each continuation", () => {
    const folded = foldLine(`SUMMARY:${"x".repeat(200)}`);
    const parts = folded.split("\r\n");

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].length).toBe(75);
    // A continuation is only a continuation because of the space.
    for (const part of parts.slice(1)) expect(part.startsWith(" ")).toBe(true);
  });

  /*
   * The one worth the file. The limit is 75 OCTETS, not characters — folding on
   * `.length` looks right in an ASCII test and splits a multi-byte sequence in
   * half the first time somebody's name has an accent in it, which the client
   * renders as replacement characters.
   */
  it("never splits a character in half", () => {
    const folded = foldLine(`SUMMARY:${"é".repeat(80)}`);

    expect(folded).not.toContain("�");
    // Unfolding must return exactly what went in.
    expect(folded.split("\r\n ").join("")).toBe(`SUMMARY:${"é".repeat(80)}`);
  });

  it("counts octets, so a two-byte line folds sooner than a one-byte one", () => {
    // 40 two-byte characters is 80 octets and must fold; 40 ASCII is 40 and
    // must not. Identical `.length`, opposite answers.
    expect(foldLine("é".repeat(40)).includes("\r\n ")).toBe(true);
    expect(foldLine("e".repeat(40)).includes("\r\n ")).toBe(false);
  });
});

describe("the document", () => {
  it("is CRLF throughout, including the last line", () => {
    const ics = buildCalendar({ name: "Shifts", events: [shift()], now: NOW });

    // A lone LF is what several parsers reject, and it is invisible in a diff.
    expect(ics.includes("\n")).toBe(true);
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("opens and closes the calendar", () => {
    const ics = buildCalendar({ name: "Shifts", events: [], now: NOW });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("is still a valid calendar with no events at all", () => {
    // A new starter with no shifts must get an empty calendar, not a broken
    // one — the client would otherwise report the URL as invalid forever.
    const ics = buildCalendar({ name: "Shifts", events: [], now: NOW });
    expect(ics).toContain("VERSION:2.0");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("marks an unaccepted shift tentative", () => {
    const ics = buildCalendar({
      name: "Shifts",
      events: [shift({ status: "tentative" })],
      now: NOW,
    });
    expect(ics).toContain("STATUS:TENTATIVE");
  });

  it("marks an accepted shift confirmed", () => {
    const ics = buildCalendar({ name: "Shifts", events: [shift()], now: NOW });
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  /*
   * The stability that stops a feed re-notifying. Clients match events across
   * fetches by UID, so two builds of the same shift must produce the same one —
   * derive it from anything volatile and every poll reads as a deletion and a
   * recreation.
   */
  it("keeps a UID identical across two builds", () => {
    const first = buildCalendar({ name: "Shifts", events: [shift()], now: NOW });
    const later = buildCalendar({
      name: "Shifts",
      events: [shift()],
      now: new Date(NOW.getTime() + 86_400_000),
    });

    const uid = (ics: string) => ics.match(/UID:(.+)\r\n/)?.[1];
    expect(uid(first)).toBe(uid(later));
    // And DTSTAMP does move, or the client cannot tell the fetches apart.
    expect(first).not.toBe(later);
  });

  it("omits optional fields rather than emitting empty ones", () => {
    const ics = buildCalendar({
      name: "Shifts",
      events: [shift({ description: null })],
      now: NOW,
    });
    expect(ics).not.toContain("DESCRIPTION:");
  });

  it("folds a long summary rather than emitting an over-length line", () => {
    const ics = buildCalendar({
      name: "Shifts",
      events: [shift({ summary: "Deep clean ".repeat(20) })],
      now: NOW,
    });

    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});
