/**
 * Confirm Dialog Component (Boundary Layer)
 *
 * Accessible modal confirmation dialog that replaces window.confirm()
 * throughout the app. Uses a portal so it layers above everything.
 */
"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called when the user cancels or presses Escape. */
  onCancel: () => void;
  /** Dialog heading. */
  title: string;
  /** Body text explaining what will happen. */
  description: string;
  /** Label for the confirm button. */
  confirmLabel?: string;
  /** Visual style of the confirm button. */
  variant?: "destructive" | "default";
  /** Disable the confirm button (e.g. while an async action runs). */
  loading?: boolean;
  /** Extra Tailwind classes on the panel. */
  className?: string;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "default",
  loading = false,
  className,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  /* Focus the confirm button when the dialog opens */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  /* Close on Escape */
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity"
        onClick={onCancel}
        aria-hidden
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={cn(
          "relative z-10 mx-4 w-full max-w-md rounded-xl bg-card p-6 text-card-foreground shadow-lg ring-1 ring-foreground/10",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          {variant === "destructive" && (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
              <AlertTriangle className="size-5 text-red-600 dark:text-red-300" />
            </div>
          )}
          <div className="flex-1">
            <h2
              id={titleId}
              className="text-base font-semibold"
            >
              {title}
            </h2>
            <p
              id={descriptionId}
              className="mt-1 text-sm text-muted-foreground"
            >
              {description}
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Processing…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
