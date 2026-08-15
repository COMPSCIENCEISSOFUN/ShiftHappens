/**
 * The application's two button styles, as class strings.
 *
 */

/** Filled indigo. The affirmative action — save, create, generate. */
export const PRIMARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60";

/** Outlined. Cancel, dismiss, and secondary navigation. */
export const SECONDARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Filled red. Reserved for actions with consequences beyond the current row —
 * suspending a whole tenant, revoking access. Reads as a warning at rest.
 */
export const DANGER_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950";

/**
 * Neutral at rest, red on hover. The right weight for a per-row delete sitting
 * among several other controls, where a filled red button would shout.
 *
 * Both exist because both are in use and they are not interchangeable. Picking
 * between them is a judgement about consequence, not about taste: if undoing it
 * means restoring from a backup or emailing a customer, it is DANGER_BUTTON.
 */
export const DANGER_GHOST_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-red-400 hover:text-red-600 dark:hover:text-red-400";

/**
 * Makes a button fill the row on a phone and shrink back at `sm`.
 *
 * Compose through `cn()`, never by string concatenation: this overrides the
 * base `py-1.5`, and two conflicting Tailwind paddings in one class attribute
 * resolve by stylesheet order, not by which was written last. `cn()` runs
 * tailwind-merge, which drops the loser. Plain concatenation would appear to
 * work and then change with an unrelated build.
 *
 *   cn(PRIMARY_BUTTON, BUTTON_STRETCH_MOBILE)
 */
export const BUTTON_STRETCH_MOBILE = "flex-1 justify-center py-2 sm:flex-initial";
