/**
 * Everything the assign panel needs to know, fetched once and shared.
 */
"use client";

import { useCallback, useState } from "react";
import type {
  CompositionCandidate,
  CompositionRule,
} from "@/lib/composition-rules";

export interface EligibilityCheck {
  eligible: boolean;
  reason?: string;
}

/**
 * `checks` is deliberately a `Record` rather than the service's fixed five
 * keys, so a dimension added server-side renders without a build failure —
 * every reader only ever iterates it.
 */
export interface EligibilityResult {
  membershipId: string;
  memberName: string;
  employmentType?: string;
  eligible: boolean;
  checks: Record<string, EligibilityCheck>;
  overrides: string[];
  /** How often this member has been waved past their own availability lately. */
  askedDespiteUnavailable?: number;
}

/** One AI-ranked candidate from `GET /tasks/[taskId]/suggest`. */
export interface AISuggestion {
  membershipId: string;
  rank: number;
  score: number;
  explanation: string;
}

/**
 * An unanswered leave request covering a day this shift runs on.
 *
 * A warning rather than a block. Leave binds on approval, so the person is
 * genuinely still rosterable — the point is that the manager should know they
 * asked before deciding, rather than finding out when the request is approved
 * and the shift has to be unpicked.
 */
export interface PendingLeave {
  id: string;
  membershipId: string;
  date: string;
  isAvailable: boolean;
  reason: string | null;
}

/**
 * The task's composition rules plus each candidate's attributes.
 *
 * Sent as data rather than as a verdict because the verdict changes with every
 * tick: the panel runs the same pure functions the server enforces with over
 * whoever is currently selected. Asking the server per click would be a request
 * per click and would still be a frame behind.
 */
export interface CompositionInfo {
  rules: CompositionRule[];
  requiredHeadcount: number;
  assignedMembershipIds: string[];
  members: CompositionCandidate[];
}

export interface AssignData {
  eligibility: Record<string, EligibilityResult>;
  loadingEligibility: boolean;
  pendingLeave: PendingLeave[];
  composition: CompositionInfo | null;
  suggestions: AISuggestion[];
  loadingSuggestions: boolean;
}

const EMPTY: AssignData = {
  eligibility: {},
  loadingEligibility: false,
  pendingLeave: [],
  composition: null,
  suggestions: [],
  loadingSuggestions: false,
};

export function useAssignData(
  orgId: string,
  /**
   * May this caller ask the engine to rank? Permission AND plan, resolved by
   * the CALLER.
   *
   * This was briefly read inside the hook with `usePlan()`, which was a bug
   * worth remembering: `usePlan` falls back to the FREE tier when it cannot
   * reach its provider, so any tree where the context was not resolvable at
   * this point silently produced no rankings — no error, no 403, no console
   * line, just an assign panel that had quietly lost half its content on a
   * plan that pays for it.
   *
   * A hook is the wrong place to source that answer. Both callers are
   * components that already compute it correctly from real context, and
   * passing it in means there is one source of truth rather than a second one
   * that fails closed in silence.
   */
  canSuggest: boolean
) {
  const [data, setData] = useState<AssignData>(EMPTY);

  /**
   * The three things a panel needs the moment it opens.
   *
   * Fetched together rather than in sequence: they are independent, and a
   * manager waiting on three round trips one after another is waiting for no
   * reason. Only eligibility reports loading — the other two are annotations on
   * a list that is already usable.
   */
  const load = useCallback(
    async (taskId: string) => {
      setData((d) => ({ ...d, loadingEligibility: true }));

      const eligibility = fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/eligibility`
      )
        .then(async (res) => {
          const body = await res.json();
          // An error body is not iterable. Iterating it threw into an empty
          // catch, and every member silently showed as "eligibility unknown".
          if (!res.ok || !Array.isArray(body)) return {};
          const map: Record<string, EligibilityResult> = {};
          for (const item of body) map[item.membershipId] = item;
          return map;
        })
        .catch(() => ({} as Record<string, EligibilityResult>));

      const leave = fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/pending-leave`
      )
        .then(async (res) => {
          const body = await res.json();
          return res.ok && Array.isArray(body) ? (body as PendingLeave[]) : [];
        })
        .catch(() => [] as PendingLeave[]);

      const composition = fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/composition`
      )
        .then(async (res) => {
          const body = await res.json();
          return res.ok && Array.isArray(body?.rules)
            ? (body as CompositionInfo)
            : null;
        })
        .catch(() => null);

      const [e, l, c] = await Promise.all([eligibility, leave, composition]);
      setData((d) => ({
        ...d,
        eligibility: e,
        pendingLeave: l,
        composition: c,
        loadingEligibility: false,
      }));
    },
    [orgId]
  );

  /**
   * The AI ranking, separately.
   *
   * Its own call because the tasks page asks for it on demand — it costs a
   * provider request, and a manager who has already decided should not spend
   * one. The calendar asks for it on open, which is the same function with a
   * different trigger rather than a second implementation.
   *
   * Returns the suggestions so the caller can act on them, or `null` if the
   * request failed. Those are not the same answer: a shift whose every
   * candidate is busy legitimately ranks nobody, and a caller that cannot tell
   * an empty ranking from a dead provider either reports a failure that did not
   * happen or says nothing about one that did. The tasks page shows an error
   * for `null` and nothing for `[]`.
   *
   * Auto-selecting the top candidates is the PANEL's business, not this hook's:
   * it depends on how many seats are left, which is a question about the task,
   * and on what the manager has already ticked.
   */
  const loadSuggestions = useCallback(
    async (taskId: string): Promise<AISuggestion[] | null> => {
      /*
       * `smart_suggestions` is Pro and above from 2026-08-14, and the route
       * answers 403. Returning the empty ranking rather than `null` is
       * deliberate: `null` means "the request failed" and the tasks page
       * shows an error for it, which is the wrong thing to say about a plan
       * that simply does not include the feature. `[]` means "nobody was
       * ranked", and the panel renders eligibility alone — which is exactly
       * the Free product.
       */
      if (!canSuggest) {
        setData((d) => ({ ...d, suggestions: [], loadingSuggestions: false }));
        return [];
      }

      setData((d) => ({ ...d, loadingSuggestions: true }));
      try {
        const res = await fetch(
          `/api/organizations/${orgId}/tasks/${taskId}/suggest`
        );
        const body = await res.json();
        // Both shapes are in use: the route returns an array, and an older
        // caller read `.suggestions`. Accepting either costs one expression and
        // removes a way for the two screens to disagree.
        const list: AISuggestion[] | null = !res.ok
          ? null
          : Array.isArray(body)
            ? body
            : Array.isArray(body?.suggestions)
              ? body.suggestions
              : [];
        // Cleared rather than left stale on failure, for the reason the
        // composition fetch is: the last shift's ranking shown against this one
        // is a wrong answer, and a wrong answer is worse than no answer.
        setData((d) => ({
          ...d,
          suggestions: list ?? [],
          loadingSuggestions: false,
        }));
        return list;
      } catch {
        // Non-critical to the panel: eligibility still works, and a panel that
        // refused to open because a provider is down would be worse than one
        // without a ranking. The caller still learns it failed.
        setData((d) => ({ ...d, suggestions: [], loadingSuggestions: false }));
        return null;
      }
    },
    [orgId, canSuggest]
  );

  /** Clears everything. Called when a panel closes, so the next one starts blank. */
  const reset = useCallback(() => setData(EMPTY), []);

  return { ...data, load, loadSuggestions, reset };
}
