/**
 * Reading a day out of a question, without asking a model.
 *
 * ## Why this is not the model's job
 *
 * The assistant's whole design is that the provider chooses an INTENT and
 * touches no data. Letting it also extract "which day" would hand it the one
 * remaining thing that decides what gets fetched — and a model that misreads
 * "next Saturday" produces a rota for the wrong day, rendered exactly like a
 * rota for the right one. Nobody would notice until somebody did not turn up.
 *
 * Dates are also the thing rules are genuinely good at. There is no judgement
 * here, only arithmetic, and arithmetic that this codebase already has strong
 * opinions about — see the timezone note below.
 *
 * ## Everything is the ORGANISATION's calendar
 *
 * "Tomorrow" means tomorrow where the shift is worked, not where the server is.
 * On Vercel the server runs in UTC, which is eight hours behind Singapore, so
 * for the whole Singapore morning `new Date()` names the previous day — the
 * exact defect that had every calendar column drawing the day before its own
 * heading. So `now` is resolved through `localDateInTimeZone` and every result
 * is a plain `YYYY-MM-DD` calendar date, never a timestamp.
 *
 * ## Day-first, deliberately
 *
 * "8/11" is 8 November. It matches `SERVER_LOCALE`, the timezone, and the way
 * everybody who uses this product writes a date — and it is stated here rather
 * than assumed, because the American reading of the same string is a different
 * day and nothing in the string says which was meant.
 */
import { DEFAULT_TIMEZONE, localDateInTimeZone } from "@/lib/timezone";

/** A day the assistant can answer about, as the organisation's calendar sees it. */
export interface ParsedDay {
  /** `YYYY-MM-DD`, in the organisation's timezone. */
  date: string;
  /**
   * Which phrasing produced it.
   *
   * Carried so the answer can say "tomorrow" back rather than "2026-08-13" —
   * repeating somebody's own word is how they check the assistant understood
   * them, and it is cheaper than trusting them to verify a date.
   */
  said: string;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
];

/** Chat shorthand. People type "tmr" far more often than "tomorrow". */
const RELATIVE: Record<string, number> = {
  today: 0,
  tonight: 0,
  tmr: 1,
  tmrw: 1,
  tmw: 1,
  tomorrow: 1,
  yesterday: -1,
};

/** Adds days to a `YYYY-MM-DD` without touching a timezone. */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/** Day of week for a `YYYY-MM-DD`, 0 = Sunday. */
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Is this a real calendar date? Rejects 31 February rather than rolling it over. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const made = new Date(Date.UTC(year, month - 1, day));
  return (
    made.getUTCFullYear() === year &&
    made.getUTCMonth() === month - 1 &&
    made.getUTCDate() === day
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The day this question is about, or null when it names none.
 *
 * Null is a first-class answer: "who is working" without a day is a question
 * the assistant should ask about rather than guess at. Defaulting to today
 * would be a guess dressed as an answer, and the guess is wrong most of the
 * time somebody bothers to type the question.
 *
 * @param now Injected rather than read, so the tests are not a claim about the
 *   day they happen to run on — the same reason the suite has no fixed sleeps.
 */
export function parseAssistantDay(
  text: string,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): ParsedDay | null {
  const haystack = text.toLowerCase();
  const today = localDateInTimeZone(now, timeZone);

  // "the day after tomorrow" before "tomorrow", or the longer phrase never wins.
  if (/\bday after tomorrow\b/.test(haystack)) {
    return { date: shift(today, 2), said: "the day after tomorrow" };
  }

  for (const [word, offset] of Object.entries(RELATIVE)) {
    if (new RegExp(`\\b${word}\\b`).test(haystack)) {
      return { date: shift(today, offset), said: word };
    }
  }

  // ISO, which is what a date input produces if one is ever pasted in.
  const iso = haystack.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const [, y, m, d] = iso.map(Number);
    if (isRealDate(y, m, d)) {
      return { date: `${y}-${pad(m)}-${pad(d)}`, said: iso[0] };
    }
  }

  // "13 august", "13th aug", "august 13", "aug 13th", with an optional year.
  const named =
    haystack.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b(?:\s+(\d{4}))?/
    ) ?? haystack.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+(\d{4}))?/);
  if (named) {
    const dayFirst = /^\d/.test(named[1]);
    const dayPart = Number(dayFirst ? named[1] : named[2]);
    const monthWord = String(dayFirst ? named[2] : named[1]);
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(monthWord));
    if (monthIndex >= 0) {
      /*
       * The year is the one nobody says out loud, and the wrong answer is
       * silent: "13 August" asked in December means next August, not one that
       * has already happened. So an omitted year resolves FORWARD.
       */
      const year = named[3]
        ? Number(named[3])
        : (() => {
            const thisYear = Number(today.slice(0, 4));
            const candidate = `${thisYear}-${pad(monthIndex + 1)}-${pad(dayPart)}`;
            return candidate >= today ? thisYear : thisYear + 1;
          })();
      if (isRealDate(year, monthIndex + 1, dayPart)) {
        return {
          date: `${year}-${pad(monthIndex + 1)}-${pad(dayPart)}`,
          said: named[0].trim(),
        };
      }
    }
  }

  // "saturday", "next saturday", "sat".
  const weekday = haystack.match(
    /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/
  );
  if (weekday) {
    const wanted = WEEKDAYS.findIndex((d) => d.startsWith(weekday[2].slice(0, 3)));
    if (wanted >= 0) {
      const ahead = (wanted - dayOfWeek(today) + 7) % 7;
      /*
       * "Saturday" on a Saturday means today; "next Saturday" means the one
       * after. Both readings exist in ordinary speech and the difference is a
       * week of rota, so the word is honoured rather than normalised away.
       */
      const days = weekday[1] ? (ahead === 0 ? 7 : ahead) : ahead;
      return { date: shift(today, days), said: weekday[0].trim() };
    }
  }

  return null;
}
