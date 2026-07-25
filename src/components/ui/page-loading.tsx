/**
 * PageLoading Component
 *
 * Shared full-page or section loading spinner with optional label.
 * Uses CSS animation for the spinner to avoid JS overhead.
 */
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface PageLoadingProps {
  label?: string;
  className?: string;
}

export function PageLoading({ label, className }: PageLoadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-6 w-6 animate-spin" />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}
