/**
 * Reset Password Form Component (Boundary Layer)
 *
 * Allows users to set a new password using a valid reset token
 * from the URL query string. Shows an error if no token is present.
 * On success, redirects to /login.
 *
 * Wrapped in Suspense because useSearchParams requires it in
 * Next.js App Router server components.
 */

"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import { apiErrorMessage } from "@/lib/api-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // No token in URL — show invalid link message
  if (!token) {
    return (
      <Card className="ring-0 shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">Invalid Link</CardTitle>
          <CardDescription>
            This password reset link is invalid or has expired.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password: formData.get("password"),
          confirmPassword: formData.get("confirmPassword"),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(apiErrorMessage(result, "Reset failed"));
        return;
      }

      router.push("/login");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Reset your password</CardTitle>
        <CardDescription>Enter your new password below</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          {error && <AlertBanner message={error} variant="error" />}
          <div className="space-y-2">
            <Label htmlFor="password">New Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="Enter new password"
              required
              className="focus-visible:ring-indigo-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm New Password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="Confirm new password"
              required
              className="focus-visible:ring-indigo-500"
            />
          </div>
        </CardContent>
        <CardFooter className="border-0 bg-transparent">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"
            disabled={loading}
          >
            {loading ? "Resetting..." : "Reset password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading..." />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
