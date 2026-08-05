/**
 * Availability Management Page (Boundary Layer)
 * 
 * Staff can configure their weekly availability schedule
 * and set date-specific overrides (e.g. day off, extra shift).
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  useEffect(() => {
    fetchSchedule();
    fetchOverrides();
  }, [orgId]);

  async function fetchSchedule() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/availability`);
      const data = await res.json();
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
      setOverrides(data);
    } catch {}
  }

  function updateDay(index: number, field: string, value: string | boolean) {
    setSchedule((prev) =>
      prev.map((day, i) =>
        i === index ? { ...day, [field]: value } : day
      )
    );
  }

  function copyWeekdayHours() {
    const weekday = schedule.find((day) => day.dayOfWeek === 1) ?? schedule[0];
    setSchedule((current) => current.map((day) => day.dayOfWeek >= 1 && day.dayOfWeek <= 5
      ? { ...day, startTime: weekday.startTime, endTime: weekday.endTime, isAvailable: weekday.isAvailable }
      : day));
  }

  function markWholeWeekUnavailable() {
    setSchedule((current) => current.map((day) => ({ ...day, isAvailable: false })));
  }

  async function onSaveSchedule() {
    setError(null);
    setSuccess(null);
    setSavingSchedule(true);

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
      setSavingSchedule(false);
    }
  }

  async function onUpdateOverride(event: React.FormEvent<HTMLFormElement>, overrideId: string) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const res = await fetch(`/api/organizations/${orgId}/availability/overrides/${overrideId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: new Date(formData.get("overrideDate") as string).toISOString(), isAvailable: formData.get("overrideAvailable") === "true", reason: formData.get("overrideReason") || undefined }),
    });
    if (!res.ok) { const result = await res.json(); setError(result.error || "Could not update override"); return; }
    setEditingOverrideId(null); setSuccess("Override updated"); void fetchOverrides();
  }

  async function onDeleteOverride(overrideId: string) {
    const res = await fetch(`/api/organizations/${orgId}/availability/overrides/${overrideId}`, { method: "DELETE" });
    if (!res.ok) { const result = await res.json(); setError(result.error || "Could not remove override"); return; }
    setSuccess("Override removed"); void fetchOverrides();
  }

  async function onCreateOverride(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData(event.currentTarget);
    const date = formData.get("overrideDate") as string;

    try {
      const res = await fetch(`/api/organizations/${orgId}/availability/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: new Date(date).toISOString(),
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
      (event.target as HTMLFormElement).reset();
      fetchOverrides();
    } catch {
      setError("Something went wrong");
    }
  }

  if (loading) return <PageLoading />;

  return (
    <div className="max-w-3xl">
      <h2 className="mb-6 text-2xl font-bold">My Availability</h2>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* Weekly schedule */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Weekly Schedule</CardTitle>
          <CardDescription>Set your regular working hours for each day</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 border-b pb-3">
            <Button type="button" size="sm" variant="outline" onClick={copyWeekdayHours}>Copy Monday to weekdays</Button>
            <Button type="button" size="sm" variant="outline" onClick={markWholeWeekUnavailable}>Mark whole week unavailable</Button>
          </div>
          {schedule.map((day, index) => (
            <div key={day.dayOfWeek} className="flex items-center gap-4">
              <label className="flex w-32 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={day.isAvailable}
                  onChange={(e) => updateDay(index, "isAvailable", e.target.checked)}
                />
                {DAYS[day.dayOfWeek]}
              </label>
              <Input
                type="time"
                value={day.startTime}
                onChange={(e) => updateDay(index, "startTime", e.target.value)}
                disabled={!day.isAvailable}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="time"
                value={day.endTime}
                onChange={(e) => updateDay(index, "endTime", e.target.value)}
                disabled={!day.isAvailable}
                className="w-32"
              />
            </div>
          ))}
          <Button onClick={onSaveSchedule} className="mt-4" disabled={savingSchedule}>
            {savingSchedule ? "Saving..." : "Save schedule"}
          </Button>
        </CardContent>
      </Card>

      {/* Date overrides */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Date Overrides</CardTitle>
          <CardDescription>
            Override your schedule for specific dates (e.g. day off, extra shift)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateOverride} className="mb-4 flex gap-3 items-end">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" name="overrideDate" required />
            </div>
            <div className="space-y-1">
              <Label>Available?</Label>
              <select name="overrideAvailable" className="rounded-md border px-3 py-2 text-sm">
                <option value="false">Unavailable</option>
                <option value="true">Available</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Reason</Label>
              <Input name="overrideReason" placeholder="Optional reason" />
            </div>
            <Button type="submit">Add</Button>
          </form>

          {overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">No date overrides set.</p>
          ) : (
            <div className="space-y-2">
              {overrides.map((ov) => editingOverrideId === ov.id ? (
                <form key={ov.id} onSubmit={(event) => void onUpdateOverride(event, ov.id)} className="flex flex-wrap items-end gap-2 rounded-md border p-3 text-sm">
                  <Input type="date" name="overrideDate" defaultValue={ov.date.slice(0, 10)} required className="w-36" />
                  <select name="overrideAvailable" defaultValue={String(ov.isAvailable)} className="rounded-md border px-3 py-2 text-sm"><option value="false">Unavailable</option><option value="true">Available</option></select>
                  <Input name="overrideReason" defaultValue={ov.reason || ""} placeholder="Optional reason" className="max-w-xs" />
                  <Button size="sm" type="submit">Save</Button>
                  <Button size="sm" type="button" variant="outline" onClick={() => setEditingOverrideId(null)}>Cancel</Button>
                </form>
              ) : (
                <div key={ov.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                  <div>
                    <span className="font-medium">
                      {new Date(ov.date).toLocaleDateString()}
                    </span>
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                        ov.isAvailable
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {ov.isAvailable ? "Available" : "Unavailable"}
                    </span>
                    {ov.reason && (
                      <span className="ml-2 text-muted-foreground">{ov.reason}</span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditingOverrideId(ov.id)}>Edit</Button>
                    <Button size="sm" variant="outline" onClick={() => void onDeleteOverride(ov.id)}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
