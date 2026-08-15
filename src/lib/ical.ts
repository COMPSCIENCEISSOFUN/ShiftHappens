/**
 * iCalendar (RFC 5545) serialisation, as pure functions.
 *
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
    "PRODID:-//ShiftHappens//Shift Schedule//EN",
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
