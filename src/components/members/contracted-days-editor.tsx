"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Send } from "lucide-react";
import { isFullTime } from "@/lib/role-config";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DaySchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

/** All seven days open — what a new full-timer is given on the server. */
function openWeek(): DaySchedule[] {
  return DAYS.map((_, i) => ({
    dayOfWeek: i,
    startTime: "00:00",
    endTime: "23:59",
    isAvailable: true,
  }));
}

/**
 * The days a member is employed to work, for whoever sets them.
 *
 * ## Two modes, off employment type rather than role
 *
 * A FULL-TIME member is contracted, so their pattern is the employer's to set
 * and this is an editor. A CASUAL member's availability is an offer they make,
 * so it is shown read-only with the nudge that already exists — asking them to
 * review it is the honest action, and overwriting it would be a change they
 * could undo the same evening without anyone knowing.
 *
 * ## Why a Save button here, when the rest of the drawer has none
 *
 * Everything else in the drawer is one control, one request. A week is seven
 * rows of three fields; applying each keystroke would be twenty-one requests
 * for one edit, and a half-applied week is a state the roster would act on. The
 * endpoint takes the whole week in one call, so the button matches the request
 * rather than contradicting the drawer's convention.
 */
export function ContractedDaysEditor({
  orgId,
  userId,
  employmentType,
  memberName,
  onRequestReview,
}: {
  orgId: string;
  userId: string;
  employmentType: string | null;
  memberName: string;
  /** The existing "ask them to check their availability" nudge, for casuals. */
  onRequestReview?: (userId: string) => void;
}) {
  const contracted = isFullTime(employmentType);

  const [week, setWeek] = useState<DaySchedule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    /*
     * Reset before the fetch, so switching members in the drawer does not show
     * the previous one's days while the new ones load. Same disable and same
     * justification as the leave page: this is synchronising with an external
     * system, which is what effects are for.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: clears the previous member's state before loading this one's
    setLoading(true);
    setError(null);
    setSaved(false);

    fetch(`/api/organizations/${orgId}/members/${userId}/contracted-days`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data)) {
          setError(
            typeof data?.error === "string" ? data.error : "Could not load days"
          );
          return;
        }
        /*
         * An empty answer is left EMPTY rather than filled with a plausible
         * week. Somebody with no pattern is rosterable at any time, and drawing
         * a default here would make an admin think they were looking at one
         * that had been set.
         */
        setWeek(
          data.length > 0
            ? openWeek().map(
                (d) =>
                  (data as DaySchedule[]).find(
                    (r) => r.dayOfWeek === d.dayOfWeek
                  ) ?? { ...d, isAvailable: false }
              )
            : []
        );
      })
      .catch(() => {
        if (!cancelled) setError("Could not load days");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, userId]);

  function update(index: number, patch: Partial<DaySchedule>) {
    setSaved(false);
    setWeek((prev) =>
      prev ? prev.map((d, i) => (i === index ? { ...d, ...patch } : d)) : prev
    );
  }

  async function save(schedule: DaySchedule[]) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/members/${userId}/contracted-days`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schedule }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Could not save");
        return;
      }
      setWeek(schedule);
      setSaved(true);
    } catch {
      setError("Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-[12px] text-muted-foreground">Loading days…</p>;
  }

  /* ── Casual: read-only, with the nudge ─────────────────────────────── */
  if (!contracted) {
    const working = (week ?? []).filter((d) => d.isAvailable);
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-muted-foreground">
          {memberName} is casual, so their availability is theirs to set. Ask
          them to review it rather than changing it here — an edit you make is
          one they can undo the same evening.
        </p>
        <p className="text-[13px]">
          {working.length === 0
            ? "No availability set."
            : working.map((d) => DAYS[d.dayOfWeek]).join(", ")}
        </p>
        {onRequestReview && (
          <button
            type="button"
            onClick={() => onRequestReview(userId)}
            className={`${SECONDARY_BUTTON} h-8 gap-1.5`}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Ask them to review
          </button>
        )}
      </div>
    );
  }

  /* ── Full-time: editable ───────────────────────────────────────────── */
  const rows = week ?? [];

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        The days {memberName} is contracted to work. A day left unticked means
        they cannot be rostered that day at all.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="text-[12px] text-muted-foreground">
            No days set — {memberName} can currently be rostered at any time.
          </p>
          <button
            type="button"
            onClick={() => setWeek(openWeek())}
            className={`${SECONDARY_BUTTON} mt-2 h-8 gap-1.5`}
          >
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            Set working days
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {rows.map((day, index) => (
              <div
                key={day.dayOfWeek}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                  day.isAvailable
                    ? "border-indigo-200 bg-indigo-50/50 dark:border-indigo-800 dark:bg-indigo-950/20"
                    : "border-border bg-muted/20"
                }`}
              >
                <label className="flex w-20 cursor-pointer items-center gap-2 text-[12px] font-medium">
                  <input
                    type="checkbox"
                    checked={day.isAvailable}
                    onChange={(e) =>
                      update(index, { isAvailable: e.target.checked })
                    }
                    className="h-3.5 w-3.5 shrink-0 rounded border-border accent-indigo-600"
                  />
                  {DAYS[day.dayOfWeek]}
                </label>
                <input
                  type="time"
                  aria-label={`${DAYS[day.dayOfWeek]} start time`}
                  value={day.startTime}
                  disabled={!day.isAvailable}
                  onChange={(e) => update(index, { startTime: e.target.value })}
                  className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px] disabled:opacity-40"
                />
                <span className="text-[11px] text-muted-foreground">to</span>
                <input
                  type="time"
                  aria-label={`${DAYS[day.dayOfWeek]} end time`}
                  value={day.endTime}
                  disabled={!day.isAvailable}
                  onChange={(e) => update(index, { endTime: e.target.value })}
                  className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px] disabled:opacity-40"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(rows)}
              disabled={saving}
              className={`${PRIMARY_BUTTON} h-8`}
            >
              {saving ? "Saving…" : "Save working days"}
            </button>
            {saved && (
              <span className="text-[12px] text-emerald-600 dark:text-emerald-400">
                Saved
              </span>
            )}
          </div>
        </>
      )}

      {error && (
        <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
