/**
 * Calendar Assign Modal Component
 *
 * Inline staff assignment triggered from the calendar day view.
 * Fetches AI-ranked suggestions and eligibility data, shows
 * recommended staff with reasoning, eligible staff, and
 * disabled rows for ineligible (with reasons).
 * Submits assignment without leaving the calendar.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface EligibilityCheck {
  eligible: boolean;
  reason?: string;
}

interface EligibilityResult {
  membershipId: string;
  memberName: string;
  eligible: boolean;
  checks: Record<string, EligibilityCheck>;
  overrides: string[];
}

interface AISuggestion {
  membershipId: string;
  rank: number;
  score: number;
  explanation: string;
}

interface CalendarAssignModalProps {
  taskId: string;
  taskTitle: string;
  requiredHeadcount: number;
  currentCount: number;
  orgId: string;
  onClose: () => void;
  onAssigned: () => void;
}

export function CalendarAssignModal({
  taskId,
  taskTitle,
  requiredHeadcount,
  currentCount,
  orgId,
  onClose,
  onAssigned,
}: CalendarAssignModalProps) {
  const [eligibility, setEligibility] = useState<EligibilityResult[]>([]);
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingEligibility, setLoadingEligibility] = useState(true);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const remaining = requiredHeadcount - currentCount;

  const fetchEligibility = useCallback(async () => {
    setLoadingEligibility(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/eligibility`
      );
      if (res.ok) setEligibility(await res.json());
      else setError("Failed to load eligible staff");
    } catch {
      setError("Failed to load eligible staff");
    } finally {
      setLoadingEligibility(false);
    }
  }, [orgId, taskId]);

  const fetchSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/suggest`
      );
      if (res.ok) {
        const data = await res.json();
        setSuggestions(Array.isArray(data) ? data : data.suggestions || []);
      }
    } catch {
      // AI suggestions are non-critical — eligibility still works
    } finally {
      setLoadingSuggestions(false);
    }
  }, [orgId, taskId]);

  useEffect(() => {
    void fetchEligibility();
    void fetchSuggestions();
  }, [fetchEligibility, fetchSuggestions]);

  async function handleAssign() {
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ membershipIds: selected }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Assignment failed");
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        onAssigned();
        onClose();
      }, 800);
    } catch {
      setError("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleStaff(membershipId: string) {
    setSelected((prev) =>
      prev.includes(membershipId)
        ? prev.filter((id) => id !== membershipId)
        : prev.length < remaining
          ? [...prev, membershipId]
          : prev
    );
  }

  function getIneligibleReasons(checks: Record<string, EligibilityCheck>): string {
    return Object.entries(checks)
      .filter(([, v]) => !v.eligible)
      .map(([k, v]) => v.reason || k.replace(/([A-Z])/g, " $1").toLowerCase())
      .join(", ");
  }

  const loading = loadingEligibility;
  const eligible = eligibility.filter((e) => e.eligible);
  const ineligible = eligibility.filter((e) => !e.eligible);

  // Split eligible into AI-suggested (ranked) and remaining
  const suggestedIds = new Set(suggestions.map((s) => s.membershipId));
  const aiSuggested = suggestions
    .filter((s) => eligible.some((e) => e.membershipId === s.membershipId));
  const otherEligible = eligible.filter((e) => !suggestedIds.has(e.membershipId));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg border w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold">Assign staff</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {taskTitle} — needs {remaining} more
          </p>
        </div>

        {/* Content */}
        <div className="px-5 pb-3 max-h-96 overflow-y-auto">
          {loading && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Loading eligible staff...
            </p>
          )}

          {error && (
            <div className="mb-3 rounded-md bg-red-50 dark:bg-red-950 p-2.5 text-sm text-red-600 dark:text-red-300">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-3 rounded-md bg-green-50 dark:bg-green-950 p-2.5 text-sm text-green-600 dark:text-green-300">
              Staff assigned successfully
            </div>
          )}

          {!loading && eligible.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No eligible staff available for this task.
            </p>
          )}

          {/* AI Suggested staff */}
          {aiSuggested.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950 px-2 py-0.5 rounded-full">
                  ✦ AI recommended
                </span>
                {loadingSuggestions && (
                  <span className="text-xs text-muted-foreground">loading...</span>
                )}
              </div>
              {aiSuggested.map((suggestion) => {
                const staffEligibility = eligible.find(
                  (e) => e.membershipId === suggestion.membershipId
                );
                return (
                  <label
                    key={suggestion.membershipId}
                    className="flex items-start gap-3 py-2.5 cursor-pointer hover:bg-muted/50 rounded-md px-2 -mx-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(suggestion.membershipId)}
                      onChange={() => toggleStaff(suggestion.membershipId)}
                      disabled={
                        !selected.includes(suggestion.membershipId) &&
                        selected.length >= remaining
                      }
                      className="h-4 w-4 mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium truncate">
                          {eligible.find((e) => e.membershipId === suggestion.membershipId)?.memberName || "Staff"}
                        </p>
                        <span className="text-xs text-purple-600 dark:text-purple-400 ml-2 whitespace-nowrap">
                          {Math.round(suggestion.score)}% match
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {suggestion.explanation}
                      </p>
                      {staffEligibility?.overrides && staffEligibility.overrides.length > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                          Override: {staffEligibility.overrides.join(", ")}
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* Other eligible staff (not AI-suggested) */}
          {otherEligible.length > 0 && (
            <div className={aiSuggested.length > 0 ? "pt-3 border-t" : ""}>
              {aiSuggested.length > 0 && (
                <p className="text-xs text-muted-foreground mb-1">Also eligible</p>
              )}
              {otherEligible.map((staff) => (
                <label
                  key={staff.membershipId}
                  className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-muted/50 rounded-md px-2 -mx-2"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(staff.membershipId)}
                    onChange={() => toggleStaff(staff.membershipId)}
                    disabled={
                      !selected.includes(staff.membershipId) &&
                      selected.length >= remaining
                    }
                    className="h-4 w-4"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {staff.memberName}
                    </p>
                    {staff.overrides.length > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Override: {staff.overrides.join(", ")}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Eligible
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Loading indicator for AI suggestions */}
          {!loadingEligibility && loadingSuggestions && aiSuggested.length === 0 && eligible.length > 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              Loading AI recommendations...
            </p>
          )}

          {/* Ineligible staff */}
          {ineligible.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs text-muted-foreground mb-1">Ineligible</p>
              {ineligible.map((staff) => (
                <div
                  key={staff.membershipId}
                  className="flex items-center gap-3 py-2 px-2 -mx-2 opacity-50"
                >
                  <input type="checkbox" disabled className="h-4 w-4" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{staff.memberName}</p>
                    <p className="text-xs text-muted-foreground">
                      {getIneligibleReasons(staff.checks)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-5 py-3 border-t bg-muted/30">
          <p className="text-xs text-muted-foreground">
            {selected.length}/{remaining} selected
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleAssign}
              disabled={selected.length === 0 || submitting || success}
            >
              {submitting
                ? "Assigning..."
                : success
                  ? "Done"
                  : `Assign${selected.length > 0 ? ` (${selected.length})` : ""}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
