/**
 * Certification State Icon (Boundary Layer)
 *
 * One tinted glyph per certification display state — the row icon on both the
 * admin certifications page and the staff my-certifications page.
 */
import {
  CalendarX,
  CircleHelp,
  CircleX,
  Clock,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CertificationDisplayState } from "@/lib/certification-display";

interface StateIcon {
  Icon: LucideIcon;
  /** Container tint. */
  tint: string;
  /** Stroke colour. Every entry carries a dark-mode variant or is theme-neutral. */
  tone: string;
}

/**
 * Shape carries the meaning; colour reinforces it.
 *
 * `expired` and `revoked` deliberately share `bg-muted`, on the same reasoning
 * `StatusBadge` greys them both: each was legitimate once and simply no longer
 * counts. That makes the *shape* load-bearing rather than decorative — with
 * identical tints, a struck-out calendar and a struck-out shield are the only
 * thing separating those two rows. Any future edit here has to keep them
 * visually distinct without reaching for colour.
 */
const STATE_ICON: Record<CertificationDisplayState, StateIcon> = {
  pending: {
    Icon: Clock,
    tint: "bg-amber-500/[.15]",
    tone: "text-amber-600 dark:text-amber-400",
  },
  verified: {
    Icon: ShieldCheck,
    tint: "bg-green-500/[.14]",
    tone: "text-green-600 dark:text-green-400",
  },
  expiring: {
    Icon: TriangleAlert,
    tint: "bg-amber-500/[.15]",
    tone: "text-amber-600 dark:text-amber-400",
  },
  expired: {
    Icon: CalendarX,
    tint: "bg-muted",
    tone: "text-muted-foreground",
  },
  rejected: {
    Icon: CircleX,
    tint: "bg-red-500/[.13]",
    tone: "text-red-600 dark:text-red-400",
  },
  revoked: {
    Icon: ShieldOff,
    tint: "bg-muted",
    tone: "text-muted-foreground",
  },
};

/**
 * `certificationDisplayState` passes an unrecognised stored status straight
 * through rather than relabelling it, so this component can genuinely be
 * handed a state that is not in the table above.
 *
 * A question mark is the point. That module's stated position is that showing
 * an unknown status verbatim is a visible bug and quietly renaming it is an
 * invisible one; reusing the `expired` icon here would be the invisible kind.
 */
const UNKNOWN_STATE: StateIcon = {
  Icon: CircleHelp,
  tint: "bg-muted",
  tone: "text-muted-foreground",
};

/** Exported for tests. Accepts a bare string because the fallback is reachable. */
export function certificationStateIcon(state: string): StateIcon {
  // `hasOwnProperty`, not `??`. STATE_ICON is a plain object literal, so it
  // inherits from Object.prototype: a lookup of "constructor" or "toString"
  // returns an inherited member rather than undefined, the ?? fallback never
  // fires, and the caller destructures `Icon` off a Function — rendering
  // `undefined` as a component and crashing the row. An own-property check is
  // the only thing that makes the fallback cover every non-state string.
  return Object.prototype.hasOwnProperty.call(STATE_ICON, state)
    ? STATE_ICON[state as CertificationDisplayState]
    : UNKNOWN_STATE;
}

interface CertificationStateIconProps {
  state: CertificationDisplayState;
  /** Extra Tailwind classes on the tinted container. */
  className?: string;
}

/**
 * Decorative by design: every state this can show is also named in the
 * `StatusBadge` beside it, so announcing it would only repeat the badge.
 */
export function CertificationStateIcon({
  state,
  className,
}: CertificationStateIconProps) {
  const { Icon, tint, tone } = certificationStateIcon(state);

  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
        tint,
        className
      )}
      aria-hidden="true"
    >
      <Icon className={cn("h-[18px] w-[18px]", tone)} />
    </div>
  );
}
