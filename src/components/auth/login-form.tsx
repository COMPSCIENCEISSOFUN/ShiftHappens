/**
 * Login Form Component (Boundary Layer)
 *
 * Client-side login form using NextAuth's signIn function.
 * Uses the Credentials provider with redirect: false to handle
 * errors in-page rather than redirecting to an error page.
 * On success, redirects to /dashboard.
 */
"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
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

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);

    try {
      const result = await signIn("credentials", {
        email: formData.get("email") as string,
        password: formData.get("password") as string,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
        <CardDescription>
          Enter your credentials to access your account
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          {error && <AlertBanner message={error} variant="error" />}
          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
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
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter your password"
                required
                autoComplete="current-password"
                className="pr-11 focus-visible:ring-indigo-500"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-4 border-0 bg-transparent">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign in"}
          </Button>
          <div className="flex w-full justify-between text-sm">
            <Link
              href="/forgot-password"
              className="text-indigo-600 hover:text-indigo-500 hover:underline dark:text-indigo-400"
            >
              Forgot password?
            </Link>
            <Link
              href="/register"
              className="text-indigo-600 hover:text-indigo-500 hover:underline dark:text-indigo-400"
            >
              Create account
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
