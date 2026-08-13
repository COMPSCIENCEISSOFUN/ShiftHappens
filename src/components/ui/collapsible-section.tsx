/**
 * CollapsibleSection
 *
 * A titled block that can be folded away, with the choice remembered.
 *
 * ## Why remembering matters
 *
 * A collapse that resets on every page load is worse than no collapse at all —
 * the user closes the same panel every morning and eventually stops bothering.
 * The state is kept in `sessionStorage` rather than component state so it
 * survives navigating away and back.
 *
 * `sessionStorage`, not `localStorage`: the preference is "not right now",
 * which is a property of this sitting rather than of the account. It also
 * means a demo starts from the designed default every time, which is what you
 * want when showing the product to someone.
 *
 * ## Why the content is not unmounted
 *
 * Collapsing hides with CSS and keeps the children mounted. Unmounting would
 * discard any data they hold and re-fetch on every expand, turning a layout
 * preference into a network round trip. The cost is that a collapsed section
 * still renders — acceptable here, where the children are already-fetched
 * summaries rather than heavy trees.
 *
 * A count in the header is what makes a collapsed section useful: "Needs your
 * action" folded away is only safe if it still says how many things are in it.
 */
"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CollapsibleSectionProps {
  title: string;
  /** Stable key for remembering the open/closed choice. */
  storageKey: string;
  /** Shown beside the title, and the reason a folded section is still useful. */
  count?: number;
  /** Small line under the title, hidden when collapsed to keep the header tight. */
  description?: string;
  /** Rendered left of the title — an icon, usually. */
  icon?: React.ReactNode;
  /** Rendered at the right of the header, outside the toggle button. */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

function readStored(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`section:${key}`);
    return raw === null ? null : raw === "open";
  } catch {
    // Private browsing and some enterprise policies throw on access rather
    // than returning null. A section that cannot remember still has to open.
    return null;
  }
}

export function CollapsibleSection({
  title,
  storageKey,
  count,
  description,
  icon,
  action,
  defaultOpen = true,
  className,
  children,
}: CollapsibleSectionProps) {
  /**
   * Always starts at `defaultOpen`, then corrects after mount.
   *
   * Reading sessionStorage during the first render would make the server and
   * client disagree — the server has no storage — and React would discard the
   * server HTML. One frame in the default state is the cost of not hydrating
   * incorrectly.
   */
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    const stored = readStored(storageKey);
    if (stored === null) return;
    // Functional update, so `open` is not a dependency. Including it would
    // re-run this on every toggle and immediately undo the user's click.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: applies the remembered open/closed choice after hydration
    setOpen((current) => (current === stored ? current : stored));
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      window.sessionStorage.setItem(`section:${storageKey}`, next ? "open" : "closed");
    } catch {
      // Not being able to remember is not a reason to refuse to collapse.
    }
  }

  const panelId = `section-${storageKey}`;

  return (
    <section className={cn("mb-6", className)}>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
            aria-hidden="true"
          />
          {icon}
          <span className="text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground group-hover:text-foreground">
            {title}
          </span>
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-semibold text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        {action}
      </div>

      {description && open && (
        <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      )}

      {/* Hidden, not unmounted — see the note in the file header. */}
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
