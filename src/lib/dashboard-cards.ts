/**
 * What appears on a dashboard, and in what order.
 */

import type { GatedFeature } from "@/lib/subscription-tiers";

/** Ordered. Rendering follows this sequence. */
export const DASHBOARD_BANDS = ["needs", "now", "trend"] as const;

export type DashboardBand = (typeof DASHBOARD_BANDS)[number];

export const BAND_LABEL: Record<DashboardBand, string> = {
  needs: "Needs you",
  now: "What is happening",
  trend: "How it is going",
};

/**
 * What a card needs of the reader's department scope.
 *
 * `any` — scope is irrelevant, the card narrows itself.
 * `unrestricted` — the card compares or totals across the whole organisation,
 *   so a scoped reader would be shown a number that is not theirs.
 * `scoped` — the card IS the reader's own team, which an unrestricted reader
 *   does not have.
 */
export type ScopeRequirement = "any" | "unrestricted" | "scoped";

/**
 * Whose data the card is about.
 *
 * ## Why this is a field and not a wording convention
 *
 * The bands organise by WHEN something matters. They say nothing about whose
 * numbers you are looking at, so every card was individually responsible for
 * saying that in its own title — twenty cards, twenty chances to forget. One
 * did: "Tomorrow — nothing scheduled, tomorrow is clear" is the organisation's
 * rota written in the second person, and a company admin, who can never hold a
 * shift, read it as a statement about their own day.
 *
 * Declaring it here means the LAYOUT answers the question once, above a group,
 * and a new card cannot omit the answer because the field is required.
 *
 * `self` — the reader's own shifts, hours and certificates.
 * `org` — the business: coverage, other people, totals. Narrowed to the
 *   reader's departments when they have a scope, which is why the heading for
 *   this group names the organisation only for an unrestricted reader.
 */
export type CardSubject = "self" | "org";

/** Ordered: your own things first, the business second. */
export const CARD_SUBJECTS = ["self", "org"] as const;

export interface DashboardCard {
  id: string;
  band: DashboardBand;
  /**
   * Within a band. Lower is higher up, and the gaps are deliberate: inserting a
   * card between two existing ones should not mean renumbering the file.
   */
  priority: number;
  /**
   * One permission, or several of which any one will do. `null` means the card
   * is not permission-gated at all — see `rosterable`.
   */
  permission: string | readonly string[] | null;
  scope: ScopeRequirement;
  subject: CardSubject;
  /**
   * True for the self-service cards: your next shift, your hours, your
   * certificates. Not a permission — `canBeRostered` is a structural fact about
   * who the engine will consider, and self-service data needs no grant.
   */
  rosterable?: boolean;
  /**
   * A subscription feature this card needs, on top of the permission.
   *
   * Absent means the card is on every plan, which is true of all but one of
   * them: the basic dashboard and its coverage and task counts are core
   * workforce management and stay on Free.
   *
   * Gated HERE rather than inside the card component, so that a card the plan
   * excludes is never counted, never laid out and never fetched. A component
   * that renders null on a 403 still costs a request per dashboard load, and
   * an empty band that once held it still reserves its heading.
   */
  feature?: GatedFeature;
}

/**
 * Every card, in one place.
 *
 * Ordered by band then priority here purely so the file reads in the order the
 * page does; `cardsFor` sorts regardless, so this is a convenience and not a
 * contract.
 */
export const DASHBOARD_CARDS: readonly DashboardCard[] = [
  // ── Needs you ────────────────────────────────────────────────────
  /*
   * Above the alerts, because a failed payment ends the account and every other
   * item on the list assumes the account continues.
   */
  { id: "billing-warning", band: "needs", priority: 10, permission: "billing:manage", scope: "unrestricted", subject: "org" },
  { id: "pending-offers", band: "needs", priority: 20, permission: null, scope: "any", subject: "self", rosterable: true },
  { id: "expiring-certs", band: "needs", priority: 30, permission: null, scope: "any", subject: "self", rosterable: true },
  { id: "alerts", band: "needs", priority: 40, permission: "reports:view", scope: "any", subject: "org" },
  /*
   * `members:request_availability`, and not a `leave:review` of its own.
   * The leave routes made that choice deliberately — a new permission would
   * add an unticked checkbox to every custom role, so every manager holding
   * one would silently lose the queue. This card follows the route rather
   * than inventing a second answer to the same question.
   */
  { id: "leave-queue", band: "needs", priority: 50, permission: "members:request_availability", scope: "any", subject: "org" },

  // ── What is happening ────────────────────────────────────────────
  { id: "next-shift", band: "now", priority: 10, permission: null, scope: "any", subject: "self", rosterable: true },
  { id: "my-week", band: "now", priority: 20, permission: null, scope: "any", subject: "self", rosterable: true },
  { id: "coverage", band: "now", priority: 30, permission: "reports:view", scope: "any", subject: "org" },
  { id: "tomorrow", band: "now", priority: 40, permission: "reports:view", scope: "any", subject: "org" },
  { id: "team-roster", band: "now", priority: 50, permission: "calendar:view_team", scope: "scoped", subject: "org" },

  // ── How it is going ──────────────────────────────────────────────
  /*
   * Ordered so the full-width cards cluster rather than interleave.
   *
   * The three tile rows — key metrics, shifts, certificates — span both
   * columns; the four list and chart cards take one each. Alternating them
   * leaves a hole beside every half-width card that a full-width one cannot
   * squeeze in next to, and the holes move as cards withhold themselves. Wide
   * first, narrow in pairs, wide last.
   */
  { id: "key-metrics", band: "trend", priority: 10, permission: "reports:view", scope: "any", subject: "org" },
  { id: "task-summary", band: "trend", priority: 20, permission: "reports:view", scope: "any", subject: "org" },
  { id: "certification-summary", band: "trend", priority: 30, permission: "certifications:review", scope: "unrestricted", subject: "org" },
  { id: "completion-chart", band: "trend", priority: 40, permission: "reports:view", scope: "any", subject: "org" },
  { id: "department-workload", band: "trend", priority: 50, permission: "reports:view", scope: "unrestricted", subject: "org" },
  { id: "staff-utilisation", band: "trend", priority: 60, permission: "reports:view", scope: "any", subject: "org" },
  { id: "decline-reasons", band: "trend", priority: 70, permission: "reports:view", scope: "any", subject: "org" },
  /*
   * The five smart-engine panels — allocation mix, eligibility overrides,
   * coverage, response times, satisfaction. `advanced_analytics`, Pro and
   * above from 2026-08-14: `reports:view` stays on every plan because it also
   * decides which dashboard a member lands on, so the plan has to be named
   * separately.
   */
  { id: "engine", band: "trend", priority: 80, permission: "reports:view", scope: "unrestricted", subject: "org", feature: "advanced_analytics" },
  { id: "my-stats", band: "trend", priority: 90, permission: null, scope: "any", subject: "self", rosterable: true },
];

export interface DashboardReader {
  /** Everything the caller holds, system and custom combined. */
  permissions: ReadonlySet<string>;
  /**
   * Does the organisation's plan include this feature?
   *
   * Optional so that every existing caller and test keeps working: absent
   * means "assume included", which is exactly the behaviour before any card
   * was plan-gated. A caller that omits it cannot accidentally HIDE a card —
   * only fail to hide one — and the routes behind each card refuse
   * independently, so the failure mode is an empty panel rather than data
   * leaking to a plan that did not pay for it.
   */
  hasFeature?: (feature: GatedFeature) => boolean;
  /**
   * `null` for an unrestricted reader. An array scopes — and an EMPTY array is
   * a real answer, not a missing one: a manager assigned to no departments is
   * scoped to nothing.
   */
  departmentScope: string[] | null;
  /** Whether the engine would ever consider this person for a shift. */
  rosterable: boolean;
}

function holdsPermission(card: DashboardCard, reader: DashboardReader): boolean {
  if (card.permission === null) return true;
  if (typeof card.permission === "string") {
    return reader.permissions.has(card.permission);
  }
  return card.permission.some((candidate) => reader.permissions.has(candidate));
}

function satisfiesScope(card: DashboardCard, reader: DashboardReader): boolean {
  switch (card.scope) {
    case "unrestricted":
      return reader.departmentScope === null;
    case "scoped":
      /*
       * A non-empty scope. A manager assigned to no departments has a scope and
       * no team, so "my team" would be an empty card rather than an absent one.
       */
      return reader.departmentScope !== null && reader.departmentScope.length > 0;
    case "any":
      return true;
  }
}

/** True when this reader qualifies for this card. */
export function readerQualifies(
  card: DashboardCard,
  reader: DashboardReader
): boolean {
  if (card.rosterable && !reader.rosterable) return false;
  // Plan before permission, the order the route guard uses everywhere else.
  if (card.feature && reader.hasFeature && !reader.hasFeature(card.feature)) {
    return false;
  }
  return holdsPermission(card, reader) && satisfiesScope(card, reader);
}

/**
 * The cards this reader gets, in render order.
 *
 * Sorted by band then priority, with `id` breaking the tie — two cards at the
 * same priority must not swap places between renders.
 */
export function cardsFor(reader: DashboardReader): DashboardCard[] {
  return DASHBOARD_CARDS.filter((card) => readerQualifies(card, reader)).sort(
    (a, b) => {
      const band =
        DASHBOARD_BANDS.indexOf(a.band) - DASHBOARD_BANDS.indexOf(b.band);
      if (band !== 0) return band;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    }
  );
}

/** The qualifying cards of one band, in order. */
export function cardsInBand(
  reader: DashboardReader,
  band: DashboardBand
): DashboardCard[] {
  return cardsFor(reader).filter((card) => card.band === band);
}

/**
 * The qualifying cards of one band, split by subject and in render order.
 *
 * Returns only the subjects this reader has cards for, so the caller renders a
 * heading per group without asking whether the group is empty. An admin gets
 * one group and it is `org`; a plain staff member gets one and it is `self`; a
 * manager gets both, which is the reader the grouping exists for.
 */
export function bandGroups(
  reader: DashboardReader,
  band: DashboardBand
): { subject: CardSubject; cards: DashboardCard[] }[] {
  const inBand = cardsInBand(reader, band);
  return CARD_SUBJECTS.map((subject) => ({
    subject,
    cards: inBand.filter((card) => card.subject === subject),
  })).filter((group) => group.cards.length > 0);
}
