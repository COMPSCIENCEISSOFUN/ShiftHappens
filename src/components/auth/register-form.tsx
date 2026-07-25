/**
 * Register Form Component (Boundary Layer)
 *
 * Client-side registration form with name, email, password,
 * and confirm password fields. Submits to POST /api/register.
 * On success, redirects to /verify-email with a confirmation message.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function RegisterForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors([]);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const data = {
      name: formData.get("name") as string,
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      confirmPassword: formData.get("confirmPassword") as string,
    };

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      // A failing response isn't guaranteed to carry a JSON body.
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        // Zod returns per-field messages — surface them, otherwise the user
        // just sees "Validation failed" and has no idea what to change.
        const fieldErrors = result?.details?.fieldErrors as
          | Record<string, string[]>
          | undefined;
        const messages = fieldErrors
          ? Object.values(fieldErrors).flat().filter(Boolean)
          : [];

        setErrors(
          messages.length > 0
            ? messages
            : [result?.error || `Registration failed (HTTP ${response.status})`]
        );
        return;
      }

      router.push("/verify-email?registered=true");
    } catch {
      setErrors(["Something went wrong. Please try again."]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Create an account</CardTitle>
        <CardDescription>
          Register to start managing your organization
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          {errors.length > 0 && (
            <AlertBanner
              variant="error"
              message={
                errors.length === 1 ? (
                  errors[0]
                ) : (
                  <ul className="list-disc space-y-1 pl-4">
                    {errors.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                )
              }
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              name="name"
              placeholder="John Doe"
              required
              className="focus-visible:ring-indigo-500"
            />
          </div>
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
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="Create a password"
              required
              className="focus-visible:ring-indigo-500"
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters, including an uppercase letter, a lowercase
              letter, a number, and a special character.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="Confirm your password"
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
            {loading ? "Creating account..." : "Create account"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-indigo-600 hover:text-indigo-500 hover:underline dark:text-indigo-400"
            >
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
