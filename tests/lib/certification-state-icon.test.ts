/**
 * Tests for the certification state -> icon mapping.
 *
 * `certification-state-icon.tsx` exports `certificationStateIcon` with the
 * comment "Exported for tests" — and no test existed. This closes that.
 *
 * It is a `.ts` file, not `.tsx`, on purpose: `certificationStateIcon` returns a
 * plain object, so nothing here needs a DOM, `@testing-library` or a render.
 * The component wrapper around it is trivial (a div and an svg); the decisions
 * worth protecting all live in the table this function reads.
 *
 * Two of those decisions are explicitly documented in the source as things a
 * future edit must not undo, which is precisely what makes them worth pinning:
 *
 *  1. `expired` and `revoked` deliberately SHARE `bg-muted`, so shape rather
 *     than colour is what separates them. An edit that "fixes" the duplicate
 *     tint by giving one of them a colour would pass review and lose the
 *     reasoning.
 *  2. The unknown-state fallback is `CircleHelp`, NOT a reuse of `expired`.
 *     `certificationDisplayState` passes an unrecognised stored status straight
 *     through, so this branch is genuinely reachable, and rendering it as
 *     "expired" would turn a visible bug into an invisible one.
 *
 * NOTE: lucide icons are `forwardRef` OBJECTS, not functions — `typeof Icon ===
 * "function"` is false for every one of them. A previous session's verification
 * script asserted exactly that and drew the wrong conclusion from its own bug.
 */
import { describe, it, expect } from "vitest";
import { certificationStateIcon } from "@/components/ui/certification-state-icon";
import {
  Clock,
  ShieldCheck,
  TriangleAlert,
  CalendarX,
  CircleX,
  ShieldOff,
  CircleHelp,
} from "lucide-react";

const KNOWN_STATES = [
  "pending",
  "verified",
  "expiring",
  "expired",
  "rejected",
  "revoked",
] as const;

describe("certificationStateIcon — known states", () => {
  it.each([
    ["pending", Clock],
    ["verified", ShieldCheck],
    ["expiring", TriangleAlert],
    ["expired", CalendarX],
    ["rejected", CircleX],
    ["revoked", ShieldOff],
  ])("maps %s to the expected icon", (state, expected) => {
    expect(certificationStateIcon(state).Icon).toBe(expected);
  });

  it("covers every state the display module can produce", () => {
    // Guards against a new state being added to certificationDisplayState
    // without a matching row here — which would silently render a question mark.
    for (const state of KNOWN_STATES) {
      expect(certificationStateIcon(state).Icon).not.toBe(CircleHelp);
    }
  });

  it("returns a usable icon component for every state", () => {
    for (const state of KNOWN_STATES) {
      const { Icon } = certificationStateIcon(state);
      // NOT `typeof Icon === "function"` — lucide icons are forwardRef objects.
      expect(Icon).toBeTruthy();
      expect(Icon).toHaveProperty("$$typeof");
    }
  });

  it("gives every state a non-empty tint and tone", () => {
    for (const state of KNOWN_STATES) {
      const { tint, tone } = certificationStateIcon(state);
      expect(tint.trim().length).toBeGreaterThan(0);
      expect(tone.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every tone a dark variant, or makes it theme-neutral", () => {
    // A colour with no dark: variant is unreadable in dark mode. The muted
    // tokens are theme-aware already, so they need no explicit variant.
    for (const state of KNOWN_STATES) {
      const { tone } = certificationStateIcon(state);
      const themeNeutral = tone.includes("muted-foreground");
      expect(themeNeutral || tone.includes("dark:")).toBe(true);
    }
  });
});

describe("certificationStateIcon — the colour-collision guard", () => {
  it("expired and revoked share a tint", () => {
    // Documenting the decision, not just observing it: if someone changes this,
    // the test below is the one that explains why they should not have.
    expect(certificationStateIcon("expired").tint).toBe(
      certificationStateIcon("revoked").tint
    );
  });

  it("expired and revoked are still distinguishable by shape", () => {
    // The load-bearing assertion. Identical tint is fine ONLY while the icons
    // differ — otherwise the two states become indistinguishable on screen.
    expect(certificationStateIcon("expired").Icon).not.toBe(
      certificationStateIcon("revoked").Icon
    );
  });

  it("no two states share both an icon and a tint", () => {
    // Generalises the above to the whole table: any pair may share a colour, and
    // any pair may share a shape, but not both at once.
    const seen = new Map<string, string>();
    for (const state of KNOWN_STATES) {
      const { Icon, tint } = certificationStateIcon(state);
      const key = `${String((Icon as { displayName?: string }).displayName ?? Icon)}|${tint}`;
      expect(seen.has(key)).toBe(false);
      seen.set(key, state);
    }
  });
});

describe("certificationStateIcon — unknown states", () => {
  it("falls back to CircleHelp", () => {
    expect(certificationStateIcon("wat").Icon).toBe(CircleHelp);
  });

  it("does NOT reuse the expired entry as the fallback", () => {
    // The specific regression this file exists to prevent. Reusing `expired`
    // would make an unrecognised stored status look like a legitimate one.
    expect(certificationStateIcon("wat").Icon).not.toBe(
      certificationStateIcon("expired").Icon
    );
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["a near-miss", "Verified"],
    ["a legacy value", "approved"],
    ["something with punctuation", "pending!"],
  ])("falls back for %s", (_label, value) => {
    // "Verified" matters most: the table is case-sensitive, so a capitalised
    // value from the database falls through rather than matching.
    expect(certificationStateIcon(value).Icon).toBe(CircleHelp);
  });

  it("does not throw on values that collide with Object.prototype", () => {
    // A plain object literal backs the lookup, so "constructor" and
    // "toString" resolve to inherited members rather than undefined. The ??
    // fallback only catches null/undefined, so this is worth pinning.
    for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const result = certificationStateIcon(value);
      expect(result).toBeDefined();
      expect(result.Icon).toBe(CircleHelp);
    }
  });
});
