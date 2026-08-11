/**
 * iCalendar (RFC 5545) serialisation, as pure functions.
 *
 * ## Why this is a lib and not three lines in a route
 *
 * The format looks like "join some strings with newlines" and is not. Four of
 * its rules are invisible until a real client refuses the file, and by then the
 * symptom is "Google says the URL is not a calendar" with no further detail.
 *
 * **CRLF, always.** RFC 5545 §3.1 specifies CRLF between content lines. Plenty
 * of parsers tolerate LF; Outlook historically has not, and a file that imports
 * everywhere except the one client somebody uses is the worst kind of bug.
 *
 * **Folding at 75 octets.** A content line longer than 75 OCTETS must be split,
 * with each continuation beginning with a single space. Octets, not characters:
 * a shift titled with an emoji or an accented name counts more bytes than it
 * has letters, so folding on `.length` splits in the middle of a UTF-8
 * sequence and produces mojibake in the client.
 *
 * **Escaping.** Backslash, semicolon and comma are structural in TEXT values,
 * and a newline has to become a literal `\n`. A shift note reading
 * "Bring keys; ask for Mo" silently truncates without it.
 *
 * **UID must be stable.** A subscribe feed is fetched over and over; the client
 * matches events across fetches by UID. Derive it from anything volatile and
 * every refresh deletes and recreates every shift, which in most clients means
 * a fresh round of notifications for shifts the person has known about for
 * weeks.
 *
 * ## What this deliberately does not do
 *
 * No VTIMEZONE. Every timestamp is emitted in UTC with a trailing `Z`, and the
 * client converts to whatever zone its owner is in — which is the correct
 * behaviour anyway for somebody reading their rota abroad. Emitting local times
 * with a TZID would require shipping a timezone definition and keeping it
 * current, to arrive at the same instant.
 *
 * No CANCELLED events and no SEQUENCE. A subscribe feed is a full snapshot on
 * every fetch, so an event that disappears IS the cancellation. Those fields
 * matter for emailed invitations, which this is not.
 */

/** RFC 5545 §3.1: content lines are folded at 75 octets. */
const MAX_OCTETS = 75;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Splits a content line so no piece exceeds 75 octets, counting BYTES.
 *
 * Folding on character count is the subtle version of this bug: it looks
 * correct in tests written in ASCII and corrupts the first name with an accent
 * in it, because the split lands inside a multi-byte sequence.
 */
export function foldLine(line: string): string {
  // `TextEncoder`, not `Buffer` — a lib that reaches for a Node global is one
  // that cannot be imported from a client component, and nothing about
  // counting octets needs Node.
  const bytes = ENCODER.encode(line);
  if (bytes.length <= MAX_OCTETS) return line;

  const pieces: string[] = [];
  let start = 0;
  // The first line takes 75 octets; continuations take 74, because each one
  // spends an octet on the leading space that marks it as a continuation.
  let budget = MAX_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    /*
     * Walk back off a continuation byte (10xxxxxx). Without this the split
     * lands mid-character and both halves decode to replacement characters —
     * which is why this counts octets rather than trusting `slice`.
     */
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    pieces.push(DECODER.decode(bytes.subarray(start, end)));
    start = end;
    budget = MAX_OCTETS - 1;
  }

  return pieces.join("\r\n ");
}

/**
 * Escapes a TEXT value. RFC 5545 §3.3.11.
 *
 * Backslash first, or the escapes added below would themselves be escaped.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** An instant as UTC basic format: `20260814T020000Z`. */
export function formatUtc(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export interface CalendarEvent {
  /** Stable across fetches. See the file docblock. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  /** `tentative` for an offer nobody has accepted yet. */
  status: "confirmed" | "tentative";
}

export interface CalendarOptions {
  /** Shown as the calendar's name in most clients. */
  name: string;
  events: CalendarEvent[];
  /** When this snapshot was taken. Injected so a test is not about its clock. */
  now?: Date;
}

/**
 * A complete VCALENDAR document.
 *
 * `X-PUBLISHED-TTL` and `REFRESH-INTERVAL` are hints, not guarantees — every
 * client refreshes on whatever schedule it likes, and several ignore both. An
 * hour is stated because it is the shortest interval any of them honours, and
 * saying nothing means the slowest default applies.
 */
export function buildCalendar({
  name,
  events,
  now = new Date(),
}: CalendarOptions): string {
  const stamp = formatUtc(now);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Smart Task Allocation//Shift Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatUtc(event.start)}`,
      `DTEND:${formatUtc(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `STATUS:${event.status === "tentative" ? "TENTATIVE" : "CONFIRMED"}`
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // Folded last, so a line built from several parts is measured whole. The
  // trailing CRLF is required: the final line still has to be terminated.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
