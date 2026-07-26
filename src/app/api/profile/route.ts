/**
 * Profile API Endpoint (Boundary Layer)
 * PATCH /api/profile — Update user profile (name and/or password)
 * GET /api/profile — Get current user's profile (with org memberships)
 *
 * Both endpoints require authentication.
 * Password change requires current password verification.
 *
 * BCE compliant: Route → ProfileService → UserRepository
 */
import { NextRequest, NextResponse } from "next/server";
import { ProfileService } from "@/services/profile.service";
import { updateProfileSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";

const profileService = new ProfileService();

export async function PATCH(request: NextRequest) {
  try {
    const sessionUser = await getAuthenticatedUser();
    if (!sessionUser) return unauthorizedResponse();

    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await profileService.updateProfile(sessionUser.id, {
      name: parsed.data.name,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Current password is incorrect") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const sessionUser = await getAuthenticatedUser();
    if (!sessionUser) return unauthorizedResponse();

    const profile = await profileService.getFullProfile(sessionUser.id);
    if (!profile) return unauthorizedResponse();

    return NextResponse.json(profile);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}