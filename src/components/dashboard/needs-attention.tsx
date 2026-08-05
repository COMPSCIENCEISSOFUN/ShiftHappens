/**
 * Needs Attention Component (Boundary Layer)
 *
 * Shared alert list used by both Admin and Manager dashboards.
 * Renders color-coded items (danger/warning/info) with action buttons.
 * Each item links to the relevant page for resolution.
 * Supports light and dark mode.
 */
"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export interface NeedsAttentionItem {
  type: string;
  severity: "danger" | "warning" | "info";
  message: string;
  actionLabel: string;
  actionUrl: string;
  entityId?: string;
  /** True when the action POSTs to `actionUrl` rather than navigating to it. */
  actionPost?: boolean;
}

const severityStyles: Record<string, string> = {
  danger: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  info: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
};

const buttonVariants: Record<string, string> = {
  danger: "border-red-200 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900",
  warning: "border-amber-200 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900",
  info: "border-blue-200 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900",
};

export function NeedsAttention({ items }: { items: NeedsAttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">
        Needs attention
      </h3>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div
            key={`${item.type}-${item.entityId ?? i}`}
            className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm ${severityStyles[item.severity]}`}
          >
            {/* No badge. Every row here is a threshold check over a SQL
                join; four of them used to wear an "AI Insight" mark and it
                was decoration. The model's contribution to this page is the
                priority call, which marks one row and writes none of them. */}
            <span className="mr-4 leading-snug">{item.message}</span>
            <Link href={item.actionUrl}>
              <Button
                variant="outline"
                size="sm"
                className={`shrink-0 ${buttonVariants[item.severity]}`}
              >
                {item.actionLabel}
              </Button>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
