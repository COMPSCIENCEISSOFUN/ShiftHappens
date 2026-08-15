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

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAssignData,
  type EligibilityCheck,
} from "@/components/tasks/use-assign-data";
import { annotateSelection } from "@/lib/composition-rules";
import { remainingFromOccupied } from "@/lib/assignment-status";
import { apiErrorMessage } from "@/lib/api-error";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";

interface CalendarAssignModalProps {
  taskId: string;
  taskTitle: string;
  requiredHeadcount: number;
  currentCount: number;
  orgId: string;
  onClose: () => void;
  onAssigned: () => void;
}

/**
 * The two things that make a perfectly eligible person the wrong choice.
 *
 * Both are warnings, not blocks. Leave binds only on approval, so somebody who
 * has asked for the day is still rosterable — the point is that the manager
 * knows before deciding rather than when the request is approved and the shift
 * has to be unpicked. Composition is enforced by the server either way; showing
 * it here answers "who is right" instead of only "you were wrong", which is all
 * a refusal on submit can say.
 *
 * One component rather than two copies, because it renders in both the AI list
 * and the plain list, and two copies of a warning is how one of them ends up
 * saying something slightly different.
 */
function RowWarnings({
  leave,
  helps,
  breaks,
}: {
  leave?: { reason: string | null };
  helps: string[];
  breaks: string[];
}) {
  if (!leave && helps.length === 0 && breaks.length === 0) return null;

  return (
    <div className="mt-0.5 space-y-0.5">
      {leave && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Asked for this day off{leave.reason ? ` — ${leave.reason}` : ""} (not
          yet answered)
        </p>
      )}
      {breaks.map((rule) => (
        <p key={rule} className="text-xs text-red-600 dark:text-red-400">
          Would break: {rule}
        </p>
      ))}
      {helps.map((rule) => (
        <p key={rule} className="text-xs text-emerald-600 dark:text-emerald-400">
          Helps: {rule}
        </p>
      ))}
    </div>
  );
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
  /*
   * Eligibility, the AI ranking, composition and pending leave all come from
   * `useAssignData` — the same hook the tasks page's panel reads.
   *
   * This modal had its own copies of two of those four fetches and neither of
   * the other two, so the same shift showed a manager different WARNINGS
   * depending on which screen they opened it from: no composition annotations
   * and no "they have asked for this day off". Both are cases where the
   * calendar let somebody do a thing the tasks page would have warned them
   * about.
   *
   * Selection stays local. Which people are ticked is this panel's business,
   * not the shared layer's.
   */
  /*
   * Permission AND plan, resolved here in the component rather than inside
   * `useAssignData` — see the note on its `canSuggest` parameter. Both gates
   * can only deny, and the `/suggest` route enforces the same pair itself.
   */
  const { can } = usePermissions();
  const { has: planHas } = usePlan();
  const canSuggest =
    can("allocation:use_suggestions") && planHas("smart_suggestions");

  const {
    eligibility: eligibilityById,
    loadingEligibility,
    suggestions,
    loadingSuggestions,
    pendingLeave,
    composition,
    load,
    loadSuggestions,
  } = useAssignData(orgId, canSuggest);

  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  /*
   * Clamped, through the same helper the tasks page's panel reaches. Written by
   * hand this was negative on a shift whose headcount had been reduced below
   * the number already on it, which reads as "needs -1 more" and caps selection
   * at a negative.
   */
  const remaining = remainingFromOccupied(requiredHeadcount, currentCount);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads this shift's eligibility, warnings and ranking when the modal opens
    load(taskId);
    loadSuggestions(taskId);
  }, [taskId, load, loadSuggestions]);

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
        setError(apiErrorMessage(data, "Assignment failed"));
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
  /*
   * The hook keys eligibility by membership id, because that is how a panel
   * asks "what about this person". This modal walks a list, so it takes the
   * values — one expression, rather than a second shape in the shared layer.
   */
  const eligibility = Object.values(eligibilityById);
  const eligible = eligibility.filter((e) => e.eligible);
  const ineligible = eligibility.filter((e) => !e.eligible);

  /*
   * Unanswered leave, by membership.
   *
   * The tasks page has flagged this at the point of assigning since it was
   * built; this modal did not fetch it at all, so a manager assigning from the
   * calendar could roster somebody onto a day they had just asked off and find
   * out when the request was approved and the shift had to be unpicked.
   *
   * A warning, never a block — leave binds on approval, so the person is
   * genuinely still rosterable.
   */
  const leaveByMember = new Map(pendingLeave.map((l) => [l.membershipId, l]));

  /*
   * Composition, evaluated with `annotateSelection` — the same pure function
   * the tasks page runs and the same one the server enforces with.
   *
   * Recomputed on every render so the annotations follow the ticks: whether a
   * person helps or breaks a rule depends on who else is currently selected,
   * so a verdict fetched once would be a frame behind from the first click.
   *
   * This modal had no composition data at all, so a manager could assemble a
   * shift here that the tasks page would have flagged while they were choosing
   * — and then meet the refusal on submit, which tells them they were wrong
   * without telling them who was right.
   */
  const { effects: compEffects } = annotateSelection({
    rules: composition?.rules ?? [],
    members: composition?.members ?? [],
    assignedMembershipIds: composition?.assignedMembershipIds ?? [],
    selectedMembershipIds: selected,
    requiredHeadcount: composition?.requiredHeadcount ?? requiredHeadcount,
  });

  /** The two warnings a row carries, in one place so both lists render them. */
  function annotations(membershipId: string) {
    return {
      leave: leaveByMember.get(membershipId),
      helps: compEffects[membershipId]?.helps ?? [],
      breaks: compEffects[membershipId]?.breaks ?? [],
    };
  }

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
                <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950 px-2 py-0.5 rounded-full">
                  {/* The AI motif, shared with the dashboards. */}
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  AI recommended
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
                      <RowWarnings {...annotations(suggestion.membershipId)} />
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
                    <RowWarnings {...annotations(staff.membershipId)} />
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
