/**
 * Accept Invitation Page (Boundary Layer)
 *
 * Public page where invited users accept their invitation.
 * Shows org name and role, then either:
 * - New users: registration form (name + password)
 * - Existing users: one-click accept button
 *
 * Wrapped in Suspense for useSearchParams compatibility.
 */
"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface InvitationDetails {
  email: string;
  role: string;
  organization: { name: string };
}

function AcceptInvitationContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "success">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: resolves the invitation token from the URL against the server
      setStatus("error");
      return;
    }

    fetch(`/api/invitations/${token}`)
      .then((res) => {
        if (!res.ok) throw new Error("Invalid invitation");
        return res.json();
      })
      .then((data) => {
        setInvitation(data);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [token]);

  async function onAccept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const name = formData.get("name") as string;
    const password = formData.get("password") as string;

    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          name && password ? { name, password } : {}
        ),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to accept invitation");
        setLoading(false);
        return;
      }

      setStatus("success");
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  if (status === "loading") {
    return (
      <Card className="ring-0 shadow-none">
        <CardContent className="pt-6">
          <PageLoading label="Loading invitation..." />
        </CardContent>
      </Card>
    );
  }

  if (status === "error") {
    return (
      <Card className="ring-0 shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">Invalid Invitation</CardTitle>
          <CardDescription>
            This invitation link is invalid, expired, or has already been used.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === "success") {
    return (
      <Card className="ring-0 shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">Welcome!</CardTitle>
          <CardDescription>
            You have joined {invitation?.organization.name} as{" "}
            {invitation?.role}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"
            onClick={() => router.push("/login")}
          >
            Sign in to get started
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="ring-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">
          Join {invitation?.organization.name}
        </CardTitle>
        <CardDescription>
          You have been invited as <strong>{invitation?.role}</strong> to{" "}
          {invitation?.organization.name}
        </CardDescription>
      </CardHeader>
      <form onSubmit={onAccept}>
        <CardContent className="space-y-4">
          {error && <AlertBanner message={error} variant="error" />}
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={invitation?.email} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              name="name"
              placeholder="Your full name"
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
          </div>
        </CardContent>
        <CardFooter className="border-0 bg-transparent">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"
            disabled={loading}
          >
            {loading ? "Joining..." : "Accept & Join"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading..." />}>
      <AcceptInvitationContent />
    </Suspense>
  );
}
