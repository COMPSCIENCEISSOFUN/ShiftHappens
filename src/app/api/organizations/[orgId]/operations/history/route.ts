import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";

const memberships = new MembershipRepository();
const audit = new AuditLogService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { logs } = await audit.getLogs(orgId, { action: ACTIONS.AI_OPERATION_EXECUTED, userId: user.id }, 20);
    return NextResponse.json(logs.map((log) => ({
      id: log.id,
      createdAt: log.createdAt,
      request: typeof log.details === "object" && log.details && "request" in log.details ? String(log.details.request) : "Operations request",
      title: typeof log.details === "object" && log.details && "title" in log.details ? String(log.details.title) : "Operations request",
      status: typeof log.details === "object" && log.details && "status" in log.details ? String(log.details.status) : "completed",
      result: typeof log.details === "object" && log.details && "result" in log.details ? log.details.result : undefined,
    })));
  } catch {
    return NextResponse.json({ error: "Could not load recent operations." }, { status: 500 });
  }
}
