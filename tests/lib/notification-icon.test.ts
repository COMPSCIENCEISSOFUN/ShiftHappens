/**
 * Tests for the notification type → icon mapping.
 *
 * `notification-icon.tsx` exports `notificationIcon` with the comment "Exported
 * for tests" — and no test existed. This closes that, and deliberately mirrors
 * `certification-state-icon.test.ts` file-for-file, because the two modules are
 * the same idea and a reader who has understood one should recognise the other.
 *
 * It is a `.ts` file, not `.tsx`, on purpose: `notificationIcon` returns a plain
 * object, so nothing here needs a DOM, `@testing-library` or a render. The
 * component wrapper around it is a div and an svg; the decisions worth
 * protecting all live in the table this function reads.
 *
 * The module exists because the notifications page and the bell each kept their
 * own emoji table and had already drifted — the bell covered 7 types, the page
 * covered 14. That is the failure mode this file guards: the table is the only
 * copy now, so a type added to `NOTIFICATION_TYPES` without a row here shows a
 * generic bell in both places and nothing complains. The KNOWN_TYPES list below
 * is what makes that visible.
 *
 * NOTE ON `typeof`: lucide icons are `forwardRef` OBJECTS, not functions —
 * `typeof Icon === "function"` is false for every one of them. A previous
 * session's verification script asserted exactly that and drew the wrong
 * conclusion from its own bug, so the liveness check below tests `$$typeof`.
 */
import { describe, it, expect } from "vitest";
import { notificationIcon } from "@/components/ui/notification-icon";
import {
  Ban,
  Bell,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  CircleX,
  ClipboardList,
  Clock,
  Lock,
  LogOut,
  ShieldCheck,
  ShieldAlert,
  TriangleAlert,
  Undo2,
  UserCheck,
} from "lucide-react";

/**
 * Every type the icon table covers.
 *
 * Hardcoded rather than imported from `NOTIFICATION_TYPES`: that constant lives
 * in `notification.service.ts`, which pulls in the repositories and therefore
 * `PrismaClient`, and this file has no business needing a database URL to check
 * a lookup table. The cost of hardcoding is the drift this list is meant to
 * catch, which is why the `cert_expiring` case at the bottom of this file
 * exists — it pins the one place the two lists already disagree.
 */
const KNOWN_TYPES = [
  "task_assigned",
  "task_rescheduled",
  "task_cancelled",
  "task_unassigned",
  "task_completed",
  "assignment_accepted",
  "assignment_rejected",
  "withdrawal_requested",
  "withdrawal_approved",
  "withdrawal_denied",
  "cert_verified",
  "cert_rejected",
  "cert_expiring",
  "hour_limit_warning",
  "staff_ineligible",
  "org_suspended",
] as const;

describe("notificationIcon — known types", () => {
  it.each([
    ["task_assigned", ClipboardList],
    ["task_rescheduled", CalendarClock],
    ["task_cancelled", Ban],
    ["task_unassigned", Ban],
    ["task_completed", CircleCheck],
    ["assignment_accepted", UserCheck],
    ["assignment_rejected", CircleX],
    ["withdrawal_requested", LogOut],
    ["withdrawal_approved", CheckCheck],
    ["withdrawal_denied", Undo2],
    ["cert_verified", ShieldCheck],
    ["cert_rejected", TriangleAlert],
    ["cert_expiring", ShieldAlert],
    ["hour_limit_warning", Clock],
    ["staff_ineligible", TriangleAlert],
    ["org_suspended", Lock],
  ])("maps %s to the expected icon", (type, expected) => {
    expect(notificationIcon(type).Icon).toBe(expected);
  });

  it("gives every known type a specific icon rather than the fallback", () => {
    // The drift guard. A type in this list that resolves to `Bell` means the
    // table lost a row — which is invisible in the UI, because a generic bell
    // on a notification looks entirely reasonable.
    for (const type of KNOWN_TYPES) {
      expect(notificationIcon(type).Icon).not.toBe(Bell);
    }
  });

  it("returns a usable icon component for every known type", () => {
    for (const type of KNOWN_TYPES) {
      const { Icon } = notificationIcon(type);
      // NOT `typeof Icon === "function"` — lucide icons are forwardRef objects.
      expect(Icon).toBeTruthy();
      expect(Icon).toHaveProperty("$$typeof");
    }
  });

  it("gives every known type a non-empty tint and tone", () => {
    for (const type of KNOWN_TYPES) {
      const { tint, tone } = notificationIcon(type);
      expect(tint.trim().length).toBeGreaterThan(0);
      expect(tone.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every tone a dark variant, or makes it theme-neutral", () => {
    // The whole reason this module replaced emoji: a mark that ignores the
    // theme. A colour with no `dark:` variant reintroduces exactly that, on a
    // page whose background inverts. The muted tokens are theme-aware already,
    // so they need no explicit variant.
    for (const type of [...KNOWN_TYPES, "an-unrecognised-type"]) {
      const { tone } = notificationIcon(type);
      const themeNeutral = tone.includes("muted-foreground");
      expect(themeNeutral || tone.includes("dark:")).toBe(true);
    }
  });
});

describe("notificationIcon — the collision guard", () => {
  /**
   * Pairs that share BOTH an icon and a tint, and are therefore indistinguishable
   * on screen. Any pair may share a colour and any pair may share a shape; only
   * these two are allowed both.
   *
   * - `task_cancelled` / `task_unassigned` is documented in the source as
   *   deliberate: "from the recipient's point of view they are the same event:
   *   work that was theirs no longer is". Pinned so an edit that splits them
   *   has to argue with this comment first.
   * `task_completed` / `assignment_accepted` USED to be a second pair here.
   * They were split — CircleCheck and UserCheck — because they reach different
   * audiences and can land in one feed minutes apart, which is exactly when an
   * identical icon stops being a shorthand and starts being a mistake.
   */
  const DELIBERATE_DUPLICATES = [
    ["task_cancelled", "task_unassigned"],
  ] as const;

  it.each(DELIBERATE_DUPLICATES)(
    "%s and %s intentionally render identically",
    (a, b) => {
      expect(notificationIcon(a).Icon).toBe(notificationIcon(b).Icon);
      expect(notificationIcon(a).tint).toBe(notificationIcon(b).tint);
    }
  );

  it("has no icon+tint collisions beyond the one documented pair", () => {
    // Generalises the above to the whole table. A NEW collision is a real bug:
    // two different notifications that a reader cannot tell apart at a glance.
    const seen = new Map<string, string>();
    const collisions: [string, string][] = [];

    for (const type of KNOWN_TYPES) {
      const { Icon, tint } = notificationIcon(type);
      const key = `${String((Icon as { displayName?: string }).displayName ?? Icon)}|${tint}`;
      const previous = seen.get(key);
      if (previous) collisions.push([previous, type]);
      else seen.set(key, type);
    }

    expect(collisions).toEqual(
      DELIBERATE_DUPLICATES.map(([a, b]) => [a, b])
    );
  });

  it("keeps types that share a tint distinguishable by shape", () => {
    // cert_rejected and staff_ineligible both use TriangleAlert but different
    // tints; withdrawal_denied and org_suspended both use the red tint but
    // different shapes. Either axis alone is fine — this asserts the pairs that
    // share one axis genuinely differ on the other.
    expect(notificationIcon("cert_rejected").Icon).toBe(
      notificationIcon("staff_ineligible").Icon
    );
    expect(notificationIcon("cert_rejected").tint).not.toBe(
      notificationIcon("staff_ineligible").tint
    );

    expect(notificationIcon("withdrawal_denied").tint).toBe(
      notificationIcon("org_suspended").tint
    );
    expect(notificationIcon("withdrawal_denied").Icon).not.toBe(
      notificationIcon("org_suspended").Icon
    );
  });

  it("keeps withdrawal_approved off the plain green tick", () => {
    // Documented in the source and worth pinning: approving a withdrawal REMOVES
    // someone from a shift, so a CircleCheck would read as "task done" when the
    // outcome is "assignment reversed".
    expect(notificationIcon("withdrawal_approved").Icon).toBe(CheckCheck);
    expect(notificationIcon("withdrawal_approved").Icon).not.toBe(CircleCheck);
  });
});

describe("notificationIcon — unknown types", () => {
  it("falls back to Bell", () => {
    expect(notificationIcon("wat").Icon).toBe(Bell);
  });

  it("does NOT reuse any real type's icon as the fallback", () => {
    // The regression this file exists to prevent. `type` is a plain string
    // column with no database enum, so an unrecognised value is reachable — and
    // if the fallback borrowed, say, `ClipboardList`, an unknown notification
    // would be indistinguishable from a genuine task assignment.
    const fallback = notificationIcon("wat").Icon;
    for (const type of KNOWN_TYPES) {
      expect(notificationIcon(type).Icon).not.toBe(fallback);
    }
  });

  it("gives the fallback a theme-neutral tint and tone", () => {
    const { tint, tone } = notificationIcon("wat");
    expect(tint).toContain("muted");
    expect(tone).toContain("muted-foreground");
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["a near-miss on case", "Task_Assigned"],
    ["a near-miss on separator", "task-assigned"],
    ["a legacy value", "task_created"],
    ["something with punctuation", "task_assigned!"],
    ["a trailing space", "task_assigned "],
  ])("falls back for %s", (_label, value) => {
    // The case and separator variants matter most: the table is an exact-match
    // string lookup, so anything that is not byte-identical falls through.
    expect(notificationIcon(value).Icon).toBe(Bell);
  });

  it("does not throw on values that collide with Object.prototype", () => {
    // A plain object literal backs the lookup, so "constructor" and "toString"
    // resolve to INHERITED members rather than undefined. A `??` or `||`
    // fallback only catches null/undefined, so it would hand a Function to JSX
    // and crash the row — which is why the source uses hasOwnProperty.
    for (const value of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
    ]) {
      const result = notificationIcon(value);
      expect(result).toBeDefined();
      expect(result.Icon).toBe(Bell);
      expect(result.tone).toContain("muted-foreground");
    }
  });
});

describe("notificationIcon — types the service actually sends", () => {
  it("covers cert_expiring, which certification.service.ts genuinely emits", () => {
    // This test was originally written the other way round: it PINNED the fact
    // that cert_expiring had no row and fell through to the generic Bell, in
    // both the feed and the dropdown. That is precisely the drift this module
    // was created to end, so the row was added and the assertion inverted.
    expect(notificationIcon("cert_expiring").Icon).not.toBe(Bell);
  });
});
