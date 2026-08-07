/**
 * Dashboard AI Insights Component (Boundary Layer)
 * 
 * Client component that fetches and displays AI-generated
 * workforce insights, proactive alerts, and review queues.
 * Auto-loads on mount and caches results. Refresh button
 * for manual re-query after making changes.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";

interface Insight {
  summary: string;
  alerts: { type: "warning" | "info" | "success"; message: string }[];
  rejectionPatterns: { staffName: string; pattern: string }[];
}

export function DashboardInsights({ orgId }: { orgId: string }) {
  const [insights, setInsights] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/dashboard-insights`);
      if (res.ok) {
        const data = await res.json();
        setInsights(data);
      } else {
        setError("Failed to load insights");
      }
    } catch {
      setError("Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void fetchInsights();
  }, [fetchInsights]);

  function alertColor(type: string) {
    switch (type) {
      case "warning": return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300";
      case "success": return "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300";
      case "info": return "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300";
      default: return "border-gray-200 bg-gray-50 text-gray-800 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300";
    }
  }

  function alertIcon(type: string) {
    switch (type) {
      case "warning": return "⚠️";
      case "success": return "✅";
      case "info": return "ℹ️";
      default: return "📋";
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              ✨ AI Insights
            </CardTitle>
            <CardDescription>
              AI-powered workforce analysis and recommendations
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchInsights}
            disabled={loading}
          >
            {loading ? "Analyzing..." : "🔄 Refresh"}
          </Button>
        </div>
      </CardHeader>

      {/* Loading state */}
      {loading && !insights && (
        <CardContent>
          <div className="animate-pulse space-y-3">
            <div className="h-16 rounded-md bg-muted" />
            <div className="h-10 rounded-md bg-muted" />
            <div className="h-10 rounded-md bg-muted" />
          </div>
        </CardContent>
      )}

      {/* Error state */}
      {error && !loading && (
        <CardContent>
          <AlertBanner message={error} variant="error" />
        </CardContent>
      )}

      {/* Insights content */}
      {insights && !loading && (
        <CardContent className="space-y-4">
          {/* AI Summary */}
          <div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/50">
            <p className="text-sm text-blue-800 leading-relaxed dark:text-blue-300">
              {insights.summary}
            </p>
          </div>

          {/* Proactive Alerts */}
          {insights.alerts.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Alerts</p>
              {insights.alerts.map((alert, i) => (
                <div
                  key={i}
                  className={`rounded-md border p-3 text-sm ${alertColor(alert.type)}`}
                >
                  <span className="mr-2">{alertIcon(alert.type)}</span>
                  {alert.message}
                </div>
              ))}
            </div>
          )}

          {/* Rejection Patterns */}
          {insights.rejectionPatterns.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Rejection Patterns</p>
              {insights.rejectionPatterns.map((pattern, i) => (
                <div
                  key={i}
                  className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300"
                >
                  <span className="font-medium">{pattern.staffName}:</span>{" "}
                  {pattern.pattern}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
