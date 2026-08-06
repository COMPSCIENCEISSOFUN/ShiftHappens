/**
 * Availability Management Page (Boundary Layer)
 *
 * A member's own weekly pattern and their date-specific overrides.
 *
 * Restyled onto the shared page furniture — `Panel`, `StatTile`, the button
 * styles — so it matches Work Rules and Members rather than being the one
 * screen still using raw `Card`s.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CalendarClock,
  CalendarOff,
  CalendarPlus,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/panel";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface DaySchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface Override {
  id: string;
  date: string;
  isAvailable: boolean;
  reason: string | null;
  /** "approved" | "pending" | "rejected" — see the AvailabilityOverride model. */
  status: string;
}

/**
 * Hours in a "HH:mm"–"HH:mm" window, or 0 if it does not run forwards.
 *
 * Deliberately not wrapping past midnight. The availability check compares
 * these as plain strings, so a window that ends before it starts is not
 * something the engine understands either — showing it as a positive number
 * here would claim a capability the roster does not have.
 */
function windowHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return 0;
  return Math.max(0, eh * 60 + em - (sh * 60 + sm)) / 60;
}

export default function AvailabilityPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [schedule, setSchedule] = useState<DaySchedule[]>(
    DAYS.map((_, i) => ({
      dayOfWeek: i,
      startTime: "09:00",
      endTime: "17:00",
      isAvailable: i >= 1 && i <= 5,
    }))
  );
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * Whether this member's absences are requests rather than declarations.
   *
   * Read from the server, not inferred here — the same fact decides the wording
   * on this page and whether the row binds, and splitting those across client
   * and server is how a screen comes to promise something the engine does not
   * do.
   */
  const [needsApproval, setNeedsApproval] = useState(false);

  useEffect(() => {
    fetchSchedule();
    fetchOverrides();
  }, [orgId]);

  async function fetchSchedule() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/availability`);
      const data = await res.json();

      // A 403 body is `{ error }`, not an array — `data.length` was undefined
      // so the saved schedule silently vanished with no explanation.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load schedule"
        );
        return;
      }

      if (data.length > 0) {
        setSchedule((prev) =>
          prev.map((day) => {
            const saved = data.find((d: DaySchedule) => d.dayOfWeek === day.dayOfWeek);
            return saved || day;
          })
        );
      }
    } catch {
      setError("Failed to load schedule");
    } finally {
      setLoading(false);
    }
  }

  async function fetchOverrides() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/availability/overrides`);
      const data = await res.json();
      // Same shape trap — the override list is mapped over at render.
      if (res.ok && Array.isArray(data)) setOverrides(data);
    } catch {}
  }

  function updateDay(index: number, field: string, value: string | boolean) {
    setSchedule((prev) =>
      prev.map((day, i) => (i === index ? { ...day, [field]: value } : day))
    );
  }

  async function onSaveSchedule() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/organizations/${orgId}/availability`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to save schedule");
        return;
      }

      setSuccess("Schedule saved");
    } catch {
      setError("Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  async function onCreateOverride(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const date = formData.get("overrideDate") as string;

    try {
      const res = await fetch(`/api/organizations/${orgId}/availability/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: new Date(date).toISOString(),
          // Absent for a contracted member, whose picker is not rendered — and
          // absent reads as false, which is the only direction they may ask
          // for. Stated rather than left to be noticed.
          isAvailable: formData.get("overrideAvailable") === "true",
          reason: formData.get("overrideReason") || undefined,
        }),
      });

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to create override");
        return;
      }

      setSuccess("Override created");
      form.reset();
      fetchOverrides();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onDeleteOverride(id: string) {
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/availability/overrides/${id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setError(result.error || "Failed to remove override");
        return;
      }
      setSuccess("Override removed");
      fetchOverrides();
    } catch {
      setError("Something went wrong");
    }
  }

  if (loading) return <PageLoading />;

  const availableDays = schedule.filter((d) => d.isAvailable);
  const weeklyHours = availableDays.reduce(
    (total, d) => total + windowHours(d.startTime, d.endTime),
    0
  );
  // Soonest first. The server returns creation order, which puts an override
  // added today for December above one for next week.
  const sortedOverrides = [...overrides].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          My Availability
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {needsApproval
            ? "Your contracted days, and any leave you've asked for. Leave takes effect once a manager approves it."
            : "The hours you can be rostered. Anything outside these windows marks you ineligible when a manager assigns work."}
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* ── Stats ── */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label="Days available"
          value={`${availableDays.length} of 7`}
          detail="in your weekly pattern"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Hours per week"
          value={`${Math.round(weeklyHours)}h`}
          detail="across those days"
          accentColour={STAT_ACCENT.green}
        />
        <StatTile
          label="Date overrides"
          value={overrides.length}
          detail="one-off exceptions"
          accentColour={STAT_ACCENT.amber}
          valueColour={
            overrides.length > 0 ? "text-amber-600 dark:text-amber-400" : ""
          }
        />
      </div>

      {/* ── Weekly schedule ── */}
      <Panel
        title={needsApproval ? "Contracted days" : "Weekly schedule"}
        icon={CalendarClock}
        className="mb-4"
        bodyClassName="p-4"
      >
        <p className="mb-3 text-[13px] text-muted-foreground">
          {needsApproval
            ? "The days you are contracted to work. A day left unticked means you are not rostered that day at all."
            : "Your regular pattern. A day left unticked means you cannot be rostered that day at all."}
        </p>

        <div className="space-y-2">
          {schedule.map((day, index) => (
            <div
              key={day.dayOfWeek}
              className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors sm:flex-row sm:items-center sm:gap-4 ${
                day.isAvailable
                  ? "border-indigo-200 bg-indigo-50/50 dark:border-indigo-800 dark:bg-indigo-950/20"
                  : "border-border bg-muted/20"
              }`}
            >
              <label className="flex w-full cursor-pointer items-center gap-2.5 text-[13px] font-medium sm:w-36">
                <input
                  type="checkbox"
                  checked={day.isAvailable}
                  onChange={(e) => updateDay(index, "isAvailable", e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-border accent-indigo-600"
                />
                {DAYS[day.dayOfWeek]}
              </label>

              <div className="flex flex-1 items-center gap-2">
                <Input
                  type="time"
                  aria-label={`${DAYS[day.dayOfWeek]} start time`}
                  value={day.startTime}
                  onChange={(e) => updateDay(index, "startTime", e.target.value)}
                  disabled={!day.isAvailable}
                  className="h-8 w-32 text-[13px]"
                />
                <span className="text-[12px] text-muted-foreground">to</span>
                <Input
                  type="time"
                  aria-label={`${DAYS[day.dayOfWeek]} end time`}
                  value={day.endTime}
                  onChange={(e) => updateDay(index, "endTime", e.target.value)}
                  disabled={!day.isAvailable}
                  className="h-8 w-32 text-[13px]"
                />
                {day.isAvailable && (
                  <span className="ml-auto text-[12px] text-muted-foreground">
                    {windowHours(day.startTime, day.endTime).toFixed(1)}h
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onSaveSchedule}
          disabled={saving}
          className={`mt-4 ${PRIMARY_BUTTON}`}
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </Panel>

      {/* ── Date overrides ── */}
      <Panel
        title={needsApproval ? "Leave requests" : "Date overrides"}
        icon={CalendarOff}
        count={overrides.length}
        bodyClassName="p-4"
      >
        <p className="mb-3 text-[13px] text-muted-foreground">
          {needsApproval
            ? "Ask for a day off, or to work a day you normally would not. A manager reviews each one — until then you stay on the roster as usual."
            : "One-off exceptions to the pattern above — a day off, or a day you can work that you normally could not. An override wins over the weekly schedule for that date."}
        </p>

        <form
          onSubmit={onCreateOverride}
          className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-end"
        >
          <div className="space-y-1">
            <Label htmlFor="overrideDate" className="text-[12px]">
              Date
            </Label>
            <Input
              id="overrideDate"
              type="date"
              name="overrideDate"
              required
              className="h-9 text-[13px]"
            />
          </div>
          {/*
            A contracted member gets no direction to choose. They may ask for a
            day OFF and never to work one on — asking to work a day you are not
            contracted for is a change to the contract rather than an exception
            to it, and belongs to whoever sets the contracted days. The service
            refuses it either way; this is the screen agreeing with the service
            rather than offering something that would 403 on submit.

            A casual member keeps both. Their availability is an offer, so
            widening it and narrowing it are equally theirs to do.
          */}
          {!needsApproval && (
            <div className="space-y-1">
              <Label htmlFor="overrideAvailable" className="text-[12px]">
                Available?
              </Label>
              <select
                id="overrideAvailable"
                name="overrideAvailable"
                className="h-9 rounded-lg border border-border bg-background px-3 text-[13px]"
              >
                <option value="false">Unavailable</option>
                <option value="true">Available</option>
              </select>
            </div>
          )}
          <div className="flex-1 space-y-1">
            <Label htmlFor="overrideReason" className="text-[12px]">
              Reason
            </Label>
            <Input
              id="overrideReason"
              name="overrideReason"
              placeholder="Optional — e.g. medical appointment"
              className="h-9 text-[13px]"
            />
          </div>
          <button type="submit" className={`${SECONDARY_BUTTON} h-9 gap-1.5`}>
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {needsApproval ? "Request" : "Add"}
          </button>
        </form>

        {sortedOverrides.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title={needsApproval ? "No leave requested" : "No date overrides"}
            description={
              needsApproval
                ? "Your contracted days apply to every date."
                : "Your weekly schedule applies to every date."
            }
          />
        ) : (
          <div className="space-y-2">
            {sortedOverrides.map((ov) => {
              const date = new Date(ov.date);
              return (
                <div
                  key={ov.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      ov.isAvailable
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                    }`}
                  >
                    {ov.isAvailable
                      ? needsApproval
                        ? "To work"
                        : "Available"
                      : needsApproval
                        ? "Day off"
                        : "Unavailable"}
                  </span>
                  {/*
                    Pending is the state that matters most here: it is the one
                    where the row exists and does NOTHING. Leaving it unlabelled
                    would let somebody book time off, see it listed, and be
                    rostered anyway with no explanation.
                  */}
                  {ov.status !== "approved" && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        ov.status === "pending"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {ov.status === "pending" ? "Awaiting approval" : "Declined"}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {/* The weekday, not just the date — "14 Aug" alone does not
                        tell you which of your weekly windows it replaces. */}
                    <p className="truncate text-[13px] font-medium">
                      {date.toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                    {ov.reason && (
                      <p className="truncate text-[12px] text-muted-foreground">
                        {ov.reason}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => onDeleteOverride(ov.id)}
                    aria-label={`Remove override for ${date.toLocaleDateString("en-GB")}`}
                    className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
