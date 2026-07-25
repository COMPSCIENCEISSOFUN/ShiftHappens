/**
 * Organization Suspended Banner (Boundary Layer)
 * 
 * Displayed inline within the app layout when a user's
 * organization has been suspended. No redirect needed —
 * replaces the normal page content entirely.
 */
"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OrgSuspendedBanner() {
  return (
    <Card className="max-w-md w-full">
      <CardHeader>
        <CardTitle className="text-center text-red-600 dark:text-red-400">
          Organization Suspended
        </CardTitle>
      </CardHeader>
      <CardContent className="text-center space-y-4">
        <p className="text-muted-foreground">
          Your organization has been suspended by a platform administrator.
          Please contact support for more information.
        </p>
        <Button
          variant="outline"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}