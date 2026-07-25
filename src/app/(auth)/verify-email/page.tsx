/**
 * Verify Email Page (Boundary Layer)
 *
 * Handles two states:
 * - Just registered: shows "check your inbox" message
 * - Token in URL: verifies the token via API
 *
 * Wrapped in Suspense for useSearchParams compatibility.
 */
"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const justRegistered = searchParams.get("registered");
  const [status, setStatus] = useState<"loading" | "success" | "error" | "pending">(
    token ? "loading" : "pending"
  );

  useEffect(() => {
    if (!token) return;

    fetch("/api/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        setStatus(res.ok ? "success" : "error");
      })
      .catch(() => setStatus("error"));
  }, [token]);

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Email Verification</CardTitle>
        <CardDescription>
          {status === "pending" && justRegistered
            ? "We sent a verification link to your email"
            : "Verifying your email address"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "pending" && (
          <p className="text-sm text-muted-foreground">
            Please check your inbox and click the verification link to activate
            your account.
          </p>
        )}
        {status === "loading" && (
          <PageLoading label="Verifying..." />
        )}
        {status === "success" && (
          <>
            <AlertBanner
              message="Your email has been verified successfully."
              variant="success"
            />
            <Link href="/login" className="w-full">
              <Button className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600">
                Sign in to your account
              </Button>
            </Link>
          </>
        )}
        {status === "error" && (
          <AlertBanner
            message="Invalid or expired verification link. Please register again."
            variant="error"
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading..." />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
