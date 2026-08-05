import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { prisma } from "@/lib/prisma";
import { settingsImpactSummary } from "@/lib/settings-impact";

const memberships = new MembershipRepository();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.SETTINGS_UPDATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const [activeStaff, openTasks, scheduledAssignments] = await Promise.all([
      prisma.membership.count({ where: { organizationId: orgId, status: "active", role: { in: ["manager", "staff"] } } }),
      prisma.task.count({ where: { organizationId: orgId, status: "open" } }),
      prisma.taskAssignment.count({ where: { task: { organizationId: orgId, scheduledStart: { gte: new Date() } }, status: { in: ["assigned", "in_progress"] } } }),
    ]);
    const impact = { activeStaff, openTasks, scheduledAssignments };
    return NextResponse.json({ ...impact, summary: settingsImpactSummary(impact) });
  } catch {
    return NextResponse.json({ error: "Could not calculate settings impact." }, { status: 500 });
  }
}
