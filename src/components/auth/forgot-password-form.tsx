/**
 * Forgot Password Form Component (Boundary Layer)
 *
 * Two-state form: input state shows email field, submitted state
 * shows a confirmation message. Always shows success regardless
 * of whether the email exists (prevents email enumeration).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ForgotPasswordForm() {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    const formData = new FormData(event.currentTarget);

    await fetch("/api/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: formData.get("email") }),
    });

    setSubmitted(true);
    setLoading(false);
  }

  // After submission, show confirmation regardless of email existence
  if (submitted) {
    return (
      <Card className="ring-0 shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">Check your email</CardTitle>
          <CardDescription>
            If an account exists with that email, we sent a password reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="w-full">
            <Button variant="outline" className="w-full">
              Back to sign in
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Forgot password</CardTitle>
        <CardDescription>
          Enter your email to receive a password reset link
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@company.com"
              required
              className="focus-visible:ring-indigo-500"
            />
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-4 border-0 bg-transparent">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"
            disabled={loading}
          >
            {loading ? "Sending..." : "Send reset link"}
          </Button>
          <Link
            href="/login"
            className="text-sm text-indigo-600 hover:text-indigo-500 hover:underline dark:text-indigo-400"
          >
            Back to sign in
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
