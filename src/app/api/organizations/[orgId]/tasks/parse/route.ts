/**
 * Task Parser API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks/parse
 * 
 * Parses natural language into structured task data.
 * Admin types a sentence, AI extracts task fields.
 * The result pre-fills the create form for review.
 */
import { NextRequest, NextResponse } from "next/server";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const parser = new AITaskParserService();
const membershipRepo = new MembershipRepository();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    const parsed = await parser.parseTaskDescription(text.trim(), orgId);
    return NextResponse.json(parsed);
  } catch (error) {
    console.error("[Task Parser Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
